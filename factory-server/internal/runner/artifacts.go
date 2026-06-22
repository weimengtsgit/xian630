// Package runner wraps the Claude CLI for one pipeline step attempt. It owns
// the per-attempt artifact directory layout (design §9), the invocation of the
// `claude` binary with stage-tightened tool permissions, and the post-run file
// audit (`git status --porcelain` + declared-path checks). It does NOT validate
// the produced output.json — that lives in contracts.go — and it does NOT wire
// into the executor's StepRunner (that is Task 12/16).
package runner

import (
	"path/filepath"
	"strconv"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// AttemptWorkspace describes the on-disk artifact directory for one attempt of
// one step of one job. The layout matches design §6/§9:
//
//	<Root>/jobs/<JobID>/<StepKind>/attempt-<Attempt>/
//	  input.json prompt.md output.json output.md stdout.log stderr.log
//
// Root is typically ".factory-runs" (repo-relative) but is opaque to this type
// so callers can point it at a temp dir in tests.
type AttemptWorkspace struct {
	Root     string
	JobID    string
	StepKind model.StepKind
	Attempt  int
}

// Dir is the attempt directory itself, the parent of every artifact file.
func (w AttemptWorkspace) Dir() string {
	return filepath.Join(w.Root, "jobs", w.JobID, string(w.StepKind), "attempt-"+strconv.Itoa(w.Attempt))
}

// InputPath is where the runner writes the JSON input to the Claude agent.
func (w AttemptWorkspace) InputPath() string { return filepath.Join(w.Dir(), "input.json") }

// PromptPath is where the runner writes the markdown prompt / system prompt.
func (w AttemptWorkspace) PromptPath() string { return filepath.Join(w.Dir(), "prompt.md") }

// OutputPath is where the Claude agent is instructed to write output.json.
func (w AttemptWorkspace) OutputPath() string { return filepath.Join(w.Dir(), "output.json") }

// OutputMDPath is the human-readable markdown companion to output.json.
func (w AttemptWorkspace) OutputMDPath() string { return filepath.Join(w.Dir(), "output.md") }

// StdoutPath captures the claude process stdout for audit (design §6).
func (w AttemptWorkspace) StdoutPath() string { return filepath.Join(w.Dir(), "stdout.log") }

// StderrPath captures the claude process stderr for audit (design §6).
func (w AttemptWorkspace) StderrPath() string { return filepath.Join(w.Dir(), "stderr.log") }

// AuditDir is the sanitized audit-copy directory under one attempt. The
// operational input.json / prompt.md / output.json live directly under Dir()
// and MUST stay byte-for-byte intact (Claude execution and output validation
// depend on their exact bytes). The artifact-capture layer writes REDACTED,
// capped copies of those files here and registers ONLY these copies as
// artifacts — never the operational originals. Command stdout.log/stderr.log
// are audit-only and are also written redacted+capped under this dir.
func (w AttemptWorkspace) AuditDir() string { return filepath.Join(w.Dir(), "audit") }

// AuditPath joins a relative filename under the audit directory. It is a thin
// filepath.Join wrapper so callers never build raw "audit/input.json" strings.
func (w AttemptWorkspace) AuditPath(name string) string { return filepath.Join(w.AuditDir(), name) }
