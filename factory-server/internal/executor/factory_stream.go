package executor

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// commandStreamBatcher turns a stream of per-line stdout/stderr callbacks into
// batched command_stdout / command_stderr records. It satisfies the design
// §命令阶段 invariants (Plan Step 4):
//
//   - A record is emitted when pending output for a stream reaches 4 KiB OR
//     100 ms have elapsed since the last flush for that stream OR Close is
//     called (final flush). The 100 ms path is kept live by a ticker so a
//     long-running, low-volume command still produces periodic records.
//   - Output ACCUMULATES — a flush RESETS the pending buffer but never
//     overwrites earlier records. This fixes the Task-2 cross-task note that
//     writeLogs wrote every command's output to the same attempt path and the
//     later command clobbered the earlier one: here each command owns its own
//     batcher and records carry sequence numbers assigned by the emitter.
//   - A single batcher serves ONE command (one stdout stream + one stderr
//     stream), so stdout and stderr are never mixed into the same record.
//
// The batcher is safe for concurrent use: stdout and stderr arrive on separate
// goroutines from the streaming runner. Each stream has its own pending buffer
// + its own last-flush timestamp, guarded by one mutex (cheap; flushes are
// coarse). The emitter's Emit is itself mutex-guarded (executor.stepEmitter),
// so sequences stay strictly ascending across both streams.
type commandStreamBatcher struct {
	ctx       context.Context
	emit      runner.StepRecordEmitter
	tick      *time.Ticker
	done      chan struct{}
	closeOnce sync.Once

	mu          sync.Mutex
	stdoutBuf   strings.Builder
	stderrBuf   strings.Builder
	stdoutFlush time.Time
	stderrFlush time.Time
}

// streamChunkThreshold is the max bytes of pending output buffered before a
// mid-stream flush (Plan Step 4: "no larger than 4 KiB"). A line that pushes
// the buffer over this is flushed immediately.
const streamChunkThreshold = 4 * 1024

// streamFlushInterval bounds how long low-volume output can sit unflushed. A
// ticker at this granularity checks both streams and flushes whichever has
// pending data older than the interval (Plan Step 4: ">100 ms").
const streamFlushInterval = 100 * time.Millisecond

// newCommandStreamBatcher builds a batcher that emits command_stdout /
// command_stderr records through emit. Start the liveness ticker with start()
// and always call close() when the command ends so the tail is flushed.
func newCommandStreamBatcher(ctx context.Context, emit runner.StepRecordEmitter) *commandStreamBatcher {
	return &commandStreamBatcher{ctx: ctx, emit: emit, done: make(chan struct{})}
}

// start launches the 100 ms liveness ticker. It is safe to skip (the batcher
// still flushes on size threshold and on close); calling it makes low-volume
// long commands produce periodic records.
func (b *commandStreamBatcher) start() {
	b.tick = time.NewTicker(streamFlushInterval)
	go b.loop()
}

func (b *commandStreamBatcher) loop() {
	for {
		select {
		case <-b.done:
			return
		case <-b.tick.C:
			b.flushAge()
		case <-b.ctx.Done():
			return
		}
	}
}

// addStdout appends a stdout line (newline re-added) and flushes whenever the
// pending buffer crosses the 4 KiB threshold. A single line larger than the
// threshold is sliced into ≤4 KiB chunks so no emitted record exceeds the cap
// (Plan Step 4: "no larger than 4 KiB"). It is the callback handed to the
// streaming runner's onStdout.
func (b *commandStreamBatcher) addStdout(line string) {
	b.appendAndMaybeFlush(&b.stdoutBuf, &b.stdoutFlush, line, model.ExecutionRecordCommandStdout, b.flushStdout)
}

// addStderr is the stderr counterpart of addStdout.
func (b *commandStreamBatcher) addStderr(line string) {
	b.appendAndMaybeFlush(&b.stderrBuf, &b.stderrFlush, line, model.ExecutionRecordCommandStderr, b.flushStderr)
}

// appendAndMaybeFlush is the shared stdout/stderr logic. It keeps the pending
// buffer + first-write timestamp, then flushes — possibly more than once — while
// the buffer is at/over the threshold, slicing the flushed content into
// ≤streamChunkThreshold records so a single gigantic line cannot produce an
// oversized record.
func (b *commandStreamBatcher) appendAndMaybeFlush(buf *strings.Builder, lastFlush *time.Time, line string, kind model.ExecutionRecordKind, flushAll func()) {
	b.mu.Lock()
	if buf.Len() == 0 {
		*lastFlush = time.Now()
	}
	buf.WriteString(line)
	buf.WriteByte('\n')
	over := buf.Len() >= streamChunkThreshold
	b.mu.Unlock()
	if !over {
		return
	}
	// Drain in ≤threshold slices. flushAll empties the whole buffer in one go,
	// which could itself exceed the cap on a huge single line; so instead drain
	// slice-by-slice here under the lock.
	b.drainInSlices(buf, kind)
}

// drainInSlices emits the buffer's contents as one or more ≤threshold records,
// clearing the buffer. Used for both the size-triggered flush and (via close)
// the final flush.
func (b *commandStreamBatcher) drainInSlices(buf *strings.Builder, kind model.ExecutionRecordKind) {
	for {
		b.mu.Lock()
		if buf.Len() == 0 {
			b.mu.Unlock()
			return
		}
		n := streamChunkThreshold
		if n > buf.Len() {
			n = buf.Len()
		}
		content := buf.String()[:n]
		// Shift the remaining bytes out of the builder.
		remain := buf.String()[n:]
		buf.Reset()
		buf.WriteString(remain)
		b.mu.Unlock()
		if b.emit != nil {
			_ = b.emit.Emit(b.ctx, kind, content)
		}
	}
}

// flushAge flushes any stream whose pending output is older than the flush
// interval. Driven by the ticker.
func (b *commandStreamBatcher) flushAge() {
	now := time.Now()
	b.mu.Lock()
	doOut := b.stdoutBuf.Len() > 0 && now.Sub(b.stdoutFlush) >= streamFlushInterval
	doErr := b.stderrBuf.Len() > 0 && now.Sub(b.stderrFlush) >= streamFlushInterval
	b.mu.Unlock()
	if doOut {
		b.flushStdout()
	}
	if doErr {
		b.flushStderr()
	}
}

func (b *commandStreamBatcher) flushStdout() {
	b.mu.Lock()
	if b.stdoutBuf.Len() == 0 {
		b.mu.Unlock()
		return
	}
	b.stdoutFlush = time.Time{}
	b.mu.Unlock()
	b.drainInSlices(&b.stdoutBuf, model.ExecutionRecordCommandStdout)
}

func (b *commandStreamBatcher) flushStderr() {
	b.mu.Lock()
	if b.stderrBuf.Len() == 0 {
		b.mu.Unlock()
		return
	}
	b.stderrFlush = time.Time{}
	b.mu.Unlock()
	b.drainInSlices(&b.stderrBuf, model.ExecutionRecordCommandStderr)
}

// close flushes any remaining pending output for both streams and stops the
// ticker. It is idempotent. Always call it when the command returns so the tail
// is not dropped.
func (b *commandStreamBatcher) close() {
	b.closeOnce.Do(func() {
		if b.tick != nil {
			b.tick.Stop()
		}
		select {
		case <-b.done:
		default:
			close(b.done)
		}
	})
	b.flushStdout()
	b.flushStderr()
}
