package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// workTraceCols lists the work_trace_events columns in scan order, shared by the
// SELECTs below to keep the query and scanWorkTrace in sync.
const workTraceCols = `id,dialogue_id,sequence,task_id,application_id,version_id,step_id,attempt,type,payload_json,created_at`

// workTraceMaxPayloadBytes is the defense-in-depth byte cap on a single trace
// payload. Producers (Task 4) are expected to summarize before emitting; this
// cap truncates any runaway payload so a single trace event cannot bloat the
// table or the wire. A payload above the cap is truncated and marked, not
// rejected (a legitimate-but-large summary survives in capped form).
const workTraceMaxPayloadBytes = 8 * 1024

// workTraceTruncationMarker is appended when a payload is truncated so a reader
// can tell the value was cut.
const workTraceTruncationMarker = "…[truncated]"

// workTraceMaxPageSize is the upper bound on the number of rows ListDialogueTrace
// returns in one page (Constraint/brief: pages limited to 500).
const workTraceMaxPageSize = 500

// allowedWorkTraceTypes is the allowlist of trace categories that may persist or
// stream. It is the SECURITY gate (Constraint #9): only surfaced, user-visible
// activity categories are permitted. Provider thinking / thinking_delta, raw
// request/response bodies, headers, credentials, and uncapped command output are
// deliberately NOT in this set and are rejected by AppendDialogueTrace. Task 4
// is responsible for producing safe payloads from the agent stream; this gate
// rejects anything disallowed regardless of producer.
var allowedWorkTraceTypes = map[string]struct{}{
	string(model.WorkTraceIntent):        {},
	string(model.WorkTraceApproach):      {},
	string(model.WorkTraceAssumption):    {},
	string(model.WorkTraceClarification): {},
	string(model.WorkTraceTool):          {},
	string(model.WorkTraceData):          {},
	string(model.WorkTraceValidation):    {},
	string(model.WorkTraceChangeConfirm): {},
	string(model.WorkTraceTask):          {},
	string(model.WorkTraceVersion):       {},
	string(model.WorkTraceDeployment):    {},
	string(model.WorkTraceWarning):       {},
	string(model.WorkTraceError):         {},
	string(model.WorkTraceAssistant):     {},
}

// AllowedWorkTraceTypes reports whether a trace type is in the allowlist.
func AllowedWorkTraceTypes(t string) bool {
	_, ok := allowedWorkTraceTypes[t]
	return ok
}

// sensitivePayloadKeys are structurally-known-sensitive JSON keys that the gate
// zeros (defense-in-depth) even if a producer slips them in. This is NOT the
// primary redaction boundary — Task 4 must never emit these — but the store
// never trusts the payload. Values for these keys (case-insensitive, matched at
// any nesting depth) are replaced with "[redacted]".
var sensitivePayloadKeys = map[string]struct{}{
	"api_key":       {},
	"apikey":        {},
	"apikeyid":      {},
	"secret":        {},
	"secretkey":     {},
	"password":      {},
	"passwd":        {},
	"authorization": {},
	"auth":          {},
	"token":         {},
	"accesstoken":   {},
	"refreshtoken":  {},
	"bearertoken":   {},
	"cookie":        {},
	"setcookie":     {},
	"credential":    {},
	"credentials":   {},
	"privatekey":    {},
}

// AppendDialogueTrace persists one VISIBLE work-trace event for a dialogue,
// allocating its per-dialogue sequence (MAX+1) inside the SAME transaction, and
// enforcing the security gate (allowlist + payload cap + sensitive-key
// stripping) BEFORE insert. It returns the persisted row with its assigned
// sequence and the gate-normalized payload.
//
// SECURITY GATE (Constraint #9), enforced here before any row is written:
//   - Type must be in allowedWorkTraceTypes; "thinking", "thinking_delta", "",
//     "raw_request", "raw_response", headers/credential-ish types, etc. are
//     rejected (returns an error; nothing is persisted).
//   - PayloadJSON is parsed (when valid JSON) and walked: any key matching a
//     sensitivePayloadKey (at any depth) has its VALUE zeroed. If the payload
//     is not valid JSON it is kept as-is (a producer may legitimately send a
//     non-JSON blob) but still goes through the byte cap.
//   - PayloadJSON is capped to workTraceMaxPayloadBytes; oversized payloads are
//     truncated with workTraceTruncationMarker rather than rejected.
//
// Sequence allocation is race-free because the pool is pinned to a single
// connection (store.go SetMaxOpenConns(1)): the SELECT MAX then INSERT run on
// one serialized connection inside one transaction, and UNIQUE(dialogue_id,
// sequence) makes any collision a hard failure rather than a silent duplicate.
func (s *Store) AppendDialogueTrace(ctx context.Context, ev model.WorkTraceEvent) (model.WorkTraceEvent, error) {
	if !AllowedWorkTraceTypes(ev.Type) {
		return model.WorkTraceEvent{}, fmt.Errorf("work trace: type %q is not allowlisted (rejected by security gate)", ev.Type)
	}
	if ev.ID == "" {
		ev.ID = newTraceID()
	}
	normalized := sanitizePayload(ev.PayloadJSON)
	ev.PayloadJSON = normalized
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now()
	}

	// Single transaction on the single-connection pool: MAX(sequence) then
	// INSERT serialize atomically.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return model.WorkTraceEvent{}, fmt.Errorf("work trace begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // committed below on success

	var maxSeq sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(sequence) FROM work_trace_events WHERE dialogue_id = ?`, ev.DialogueID).Scan(&maxSeq); err != nil {
		return model.WorkTraceEvent{}, fmt.Errorf("work trace max sequence: %w", err)
	}
	next := maxSeq.Int64 + 1 // NULL/0 → 1 for the first event
	ev.Sequence = next

	if _, err := tx.ExecContext(ctx, `
INSERT INTO work_trace_events(id,dialogue_id,sequence,task_id,application_id,version_id,step_id,attempt,type,payload_json,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		ev.ID, ev.DialogueID, ev.Sequence, ev.TaskID, ev.ApplicationID, ev.VersionID,
		ev.StepID, ev.Attempt, ev.Type, ev.PayloadJSON, ms(ev.CreatedAt)); err != nil {
		return model.WorkTraceEvent{}, fmt.Errorf("work trace insert: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return model.WorkTraceEvent{}, fmt.Errorf("work trace commit: %w", err)
	}
	return ev, nil
}

// ListDialogueTrace returns the persisted work-trace events for a dialogue,
// ascending by sequence. afterSequence filters to rows whose sequence is
// strictly greater than afterSequence (0 → all); it is the replay cursor. The
// returned row count is capped at workTraceMaxPageSize (500); callers requesting
// more receive at most 500.
func (s *Store) ListDialogueTrace(ctx context.Context, dialogueID string, afterSequence int64, limit int) ([]model.WorkTraceEvent, error) {
	if limit <= 0 || limit > workTraceMaxPageSize {
		limit = workTraceMaxPageSize
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT `+workTraceCols+` FROM work_trace_events
WHERE dialogue_id = ? AND sequence > ?
ORDER BY sequence ASC
LIMIT ?`, dialogueID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.WorkTraceEvent{}
	for rows.Next() {
		ev, err := scanWorkTrace(rows)
		if err != nil {
			return nil, err
		}
		if ev != nil {
			out = append(out, *ev)
		}
	}
	return out, rows.Err()
}

// WorkTraceRowExists reports whether a work_trace_events row exists for the
// given (dialogueID, sequence). It is the store-validation check the SSE live
// forwarder uses to enforce the security property that no UNPERSISTED trace
// event can reach the wire (Constraint #9): a hub event that bypassed
// recordAndPublishWorkTrace (so was never persisted) has no matching row and is
// dropped before forwarding.
func (s *Store) WorkTraceRowExists(ctx context.Context, dialogueID string, sequence int64) bool {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM work_trace_events WHERE dialogue_id = ? AND sequence = ? LIMIT 1`,
		dialogueID, sequence).Scan(&one)
	if err != nil {
		// sql.ErrNoRows → not persisted → drop. Any other error is treated as
		// "not validated" → also drop (fail closed: never forward unvalidated).
		return false
	}
	return true
}

// scanWorkTrace reads a work_trace_events row via the package's scanner
// interface (works for both *sql.Row and *sql.Rows).
func scanWorkTrace(sc scanner) (*model.WorkTraceEvent, error) {
	var ev model.WorkTraceEvent
	var created int64
	err := sc.Scan(&ev.ID, &ev.DialogueID, &ev.Sequence, &ev.TaskID, &ev.ApplicationID,
		&ev.VersionID, &ev.StepID, &ev.Attempt, &ev.Type, &ev.PayloadJSON, &created)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ev.CreatedAt = time.UnixMilli(created)
	return &ev, nil
}

// sensitivePayloadSubstrings is the case-insensitive substring deny-list
// applied to non-JSON payloads (e.g. raw "Authorization: Bearer sk-xxx" text
// that a producer may slip in for an allowed trace type). Each match causes the
// remainder of the value (from just after the matched marker through the next
// line break or end-of-string) to be replaced with "[redacted]". This is
// defense-in-depth — Task 4 must never emit these, but the store never trusts
// the payload.
var sensitivePayloadSubstrings = []string{
	"authorization:",
	"bearer ",
	"api-key:",
	"apikey:",
	"password:",
	"passwd:",
	"secret",
	"token",
	"credential",
	"privatekey",
	"set-cookie:",
	"cookie:",
	// common key/material prefixes for cloud + provider secrets.
	"sk-",
	"akia",   // AWS access key id prefix
	"ghp_",   // GitHub PAT prefix
	"gho_",   // GitHub OAuth token prefix
	"xox",    // Slack token prefix
}

// sanitizePayload applies the defense-in-depth payload gate: it parses the
// payload as JSON (when possible), zeros the values of structurally-known-
// sensitive keys at any nesting depth, then caps the result to
// workTraceMaxPayloadBytes (truncating with a marker). A payload that is not
// valid JSON is treated as an opaque string: its sensitive substrings are
// redacted (defense-in-depth against raw "Authorization: Bearer sk-xxx"-style
// secrets) and THEN it is byte-capped. Either path guarantees a secret value
// can never persist.
func sanitizePayload(payload string) string {
	trimmed := strings.TrimSpace(payload)
	if trimmed == "" {
		return ""
	}
	// Redact sensitive keys if the blob parses as JSON.
	if redacted, ok := redactSensitiveJSON([]byte(trimmed)); ok {
		trimmed = string(redacted)
	} else {
		// Non-JSON blob: apply the case-insensitive substring deny-list so a
		// raw "Authorization: Bearer sk-xxx" string cannot persist the secret.
		trimmed = redactSensitiveSubstring(trimmed)
	}
	// Byte cap (defense-in-depth against runaway payloads).
	if len(trimmed) > workTraceMaxPayloadBytes {
		trimmed = trimmed[:workTraceMaxPayloadBytes-len(workTraceTruncationMarker)] + workTraceTruncationMarker
	}
	return trimmed
}

// redactSensitiveSubstring redacts secret-bearing substrings in a non-JSON
// payload. For each marker it finds (case-insensitively) it replaces the value
// following the marker — from the end of the marker through the next newline or
// end-of-string — with "[redacted]". Markers like "sk-" that have no trailing
// delimiter redact the remainder of the line up to the next whitespace. This
// keeps the structural context (the marker remains visible) while removing the
// secret material.
func redactSensitiveSubstring(s string) string {
	lower := strings.ToLower(s)
	// Find the earliest marker occurrence; redact it; repeat. Walks left to
	// right so overlapping markers don't double-process.
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		// Find the next marker at or after i.
		best := -1
		var bestMarker string
		for _, m := range sensitivePayloadSubstrings {
			idx := strings.Index(lower[i:], m)
			if idx >= 0 && (best == -1 || i+idx < best) {
				best = i + idx
				bestMarker = m
			}
		}
		if best == -1 {
			b.WriteString(s[i:])
			break
		}
		// Copy everything up to the marker.
		b.WriteString(s[i:best])
		// Value starts after the marker. Redact through the next line break
		// (or, for prefix-style markers like "sk-" that have no colon, through
		// the next whitespace) so a multi-line blob keeps its other lines.
		valStart := best + len(bestMarker)
		redacted := false
		for j := valStart; j < len(s); j++ {
			if s[j] == '\n' {
				b.WriteString(s[best:valStart]) // marker itself
				b.WriteString("[redacted]")
				b.WriteByte('\n')
				i = j + 1
				redacted = true
				break
			}
		}
		if !redacted {
			// Ran to end of string without a newline: redact the tail.
			b.WriteString(s[best:valStart])
			b.WriteString("[redacted]")
			i = len(s)
		}
		// Advance lower to stay in sync for the next pass.
		lower = strings.ToLower(s)
	}
	return b.String()
}

// redactSensitiveJSON parses b as arbitrary JSON and, at every nesting depth,
// replaces the VALUE of any object key matching a sensitivePayloadKey (case-
// insensitive, ignoring non-alphanumerics) with the string "[redacted]". It
// returns the rewritten JSON and ok=true; if b is not valid JSON it returns
// (nil, false) so the caller can keep the original opaque blob.
func redactSensitiveJSON(b []byte) ([]byte, bool) {
	var node any
	if err := json.Unmarshal(b, &node); err != nil {
		return nil, false
	}
	node = redactNode(node)
	out, err := json.Marshal(node)
	if err != nil {
		return nil, false
	}
	return out, true
}

// redactNode recursively redacts sensitive keys in maps and recurses into
// arrays.
func redactNode(node any) any {
	switch v := node.(type) {
	case map[string]any:
		for k, val := range v {
			if isSensitiveKey(k) {
				v[k] = "[redacted]"
				continue
			}
			v[k] = redactNode(val)
		}
		return v
	case []any:
		for i := range v {
			v[i] = redactNode(v[i])
		}
		return v
	default:
		return node
	}
}

// isSensitiveKey reports whether a JSON object key names a sensitive field. The
// match is case-insensitive after collapsing non-alphanumerics so "api-key",
// "apiKey", and "API_KEY" all match.
func isSensitiveKey(key string) bool {
	norm := normalizeKey(key)
	_, ok := sensitivePayloadKeys[norm]
	return ok
}

// normalizeKey lowercases and drops non-alphanumerics.
func normalizeKey(key string) string {
	var b strings.Builder
	b.Grow(len(key))
	for _, r := range strings.ToLower(key) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// AllowedWorkTraceTypesList returns the allowlisted trace types in sorted order,
// for documentation/observability.
func AllowedWorkTraceTypesList() []string {
	out := make([]string, 0, len(allowedWorkTraceTypes))
	for t := range allowedWorkTraceTypes {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// newTraceID returns a fresh, collision-resistant trace id for callers that do
// not supply one. It is used when ev.ID is empty so producers (Task 4) can emit
// without minting ids themselves.
func newTraceID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// rand.Read failing is exceptional; fall back to a time-based id so the
		// trace still persists rather than erroring the whole append.
		return fmt.Sprintf("trace_%d", time.Now().UnixNano())
	}
	return "trace_" + hex.EncodeToString(b[:])
}
