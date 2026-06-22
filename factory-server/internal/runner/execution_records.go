package runner

import (
	"context"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// StepRecordEmitter is the scoped reporter handed to a StepRunner for one step
// attempt. The runner calls Emit for each safe record it wants persisted
// (tool activity, public summary, command stdout/stderr chunks). The executor
// owns (job, step, attempt, sequence) assignment and persistence — the emitter
// is a thin forwarder, so runners never touch the store or compute sequence.
//
// It lives in package runner (not executor) so runner.ClaudeRunner can depend
// on it without creating an import cycle (executor already imports runner).
type StepRecordEmitter interface {
	Emit(ctx context.Context, kind model.ExecutionRecordKind, content string) error
}

// ExecutionRecordUpdate is the payload the executor publishes via Executor.OnRecord
// after a record has been successfully appended to the store. It carries the
// fully-populated record (including the executor-assigned attempt+sequence) so
// SSE/subscribers (Task 4) can fan it out to clients without re-reading the DB.
type ExecutionRecordUpdate struct {
	Record model.StepExecutionRecord
}

// NopEmitter is a StepRecordEmitter that discards everything. It is the zero
// value used by tests and paths that do not care about records, so a runner
// can always call Emit without nil-checking.
type NopEmitter struct{}

// Emit discards the record and returns nil.
func (NopEmitter) Emit(context.Context, model.ExecutionRecordKind, string) error { return nil }
