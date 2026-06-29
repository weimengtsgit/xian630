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

// TraceEmitter is the scoped seam through which a runner forwards SAFE work-
// trace events (assistant observation, tool action, clarification) to the
// executor, which routes every trace through the server's persist-before-
// publish gate (recordAndPublishWorkTrace → AppendDialogueTrace). It is the
// PRODUCER side of the work-trace pipeline (Task 4): the runner produces safe,
// redacted, capped payloads and calls Trace; it never touches the store or
// computes the dialogue sequence.
//
// CRITICAL SECURITY INVARIANT (Constraint #9): only allowlisted trace categories
// ever reach TraceEmitter. Raw hidden thinking / thinking_delta / chain-of-
// thought must NEVER be passed here — they are dropped at the source
// (stream.go: emitStreamLine ignores thinking blocks). A trace that bypasses
// this seam cannot reach the SSE wire or DB because the store gate rejects any
// non-allowlisted type and the SSE forwarder validates persisted rows.
//
// Why a separate interface and not a method on StepRecordEmitter? The executor's
// real stepEmitter (which owns the job/step/dialogue attribution the gate needs)
// implements BOTH; the runner reaches it via TraceEmitterFrom(emit), a type
// assertion. NopEmitter and test-only emitters that do not implement
// TraceEmitter yield a nop trace path, so callers never nil-check.
type TraceEmitter interface {
	// Trace forwards one safe trace event. traceType is a WorkTraceType string
	// value (e.g. model.WorkTraceAssistant); payload is a JSON string or capped
	// prose already redacted by the producer. It MUST be idempotent-safe: a nil
	// receiver or a store error never aborts the agent run.
	Trace(ctx context.Context, traceType, payload string) error
}

// TraceEmitterFrom returns the TraceEmitter capability of emit when emit also
// implements it, else a NopTraceEmitter. This is how the runner discovers the
// trace seam from the StepRecordEmitter it was handed, without forcing every
// emitter implementation to implement Trace.
func TraceEmitterFrom(emit StepRecordEmitter) TraceEmitter {
	if t, ok := emit.(TraceEmitter); ok {
		return t
	}
	return NopTraceEmitter{}
}

// NopTraceEmitter is a TraceEmitter that discards everything. It is the
// fallback used when the emitter does not implement TraceEmitter.
type NopTraceEmitter struct{}

// Trace discards the trace and returns nil.
func (NopTraceEmitter) Trace(context.Context, string, string) error { return nil }

// TaskThinkingEmitter is the scoped seam through which a runner forwards raw
// model thinking events to the executor, which routes them through the server's
// persist-before-publish gate (recordAndPublishTaskThinking → AppendTaskThinking).
// This is the ONLY path that thinking ever takes; it MUST NEVER reach
// StepRecordEmitter or TraceEmitter (Constraint #9).
type TaskThinkingEmitter interface {
	// Think forwards one raw thinking delta. content is the raw thinking_delta
	// string from the Claude stream. It MUST be idempotent-safe: a nil receiver
	// or a store error never aborts the agent run.
	Think(ctx context.Context, content string) error
}

// TaskThinkingEmitterFrom returns the TaskThinkingEmitter capability of emit
// when emit also implements it, else a NopTaskThinkingEmitter.
func TaskThinkingEmitterFrom(emit StepRecordEmitter) TaskThinkingEmitter {
	if t, ok := emit.(TaskThinkingEmitter); ok {
		return t
	}
	return NopTaskThinkingEmitter{}
}

// NopTaskThinkingEmitter is a TaskThinkingEmitter that discards everything.
type NopTaskThinkingEmitter struct{}

// Think discards the thinking and returns nil.
func (NopTaskThinkingEmitter) Think(context.Context, string) error { return nil }
