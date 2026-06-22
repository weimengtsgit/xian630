package executor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/id"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// maxTextArtifactBytes is the hard cap on any single text artifact (input.json,
// prompt.md, output.json, stdout.log, stderr.log) the executor persists. Content
// beyond this is truncated, keeping the NEWEST bytes (the tail) because the tail
// is where the most recent — and usually most diagnostic — output lives (final
// error, last JSON line, etc.). 10 MiB mirrors design §6's per-artifact bound.
const maxTextArtifactBytes int64 = 10 * 1024 * 1024

// truncationPrefixBytes is the exact marker prepended to an over-cap tail. The
// byte count is the number of ORIGINAL content bytes retained after trimming to
// a UTF-8-safe boundary (<= maxTextArtifactBytes), formatted verbatim per the
// task brief.
const truncationPrefixFormat = "[TRUNCATED: retained latest %d bytes]"

// artifactWriteResult describes one writeCappedArtifact outcome so callers
// (Task 3 record emission) can stamp Truncated onto a step_execution_record.
type artifactWriteResult struct {
	BytesWritten int
	Truncated    bool
}

// sensitiveCredentialPatterns matches the two credential shapes the task brief
// names, case-insensitively, across the keywords api_key, token, secret,
// password, authorization:
//
//  1. Authorization: Bearer <token> / authorization bearer <token> HTTP header
//     form — tried FIRST so the bare-value pattern below does not swallow the
//     scheme word and leave the real token dangling.
//  2. key=value / key:value / "key":"value" forms (shell env dumps, HTTP header
//     value lines, JSON config) where the value runs to the next whitespace,
//     comma, or closing quote.
//
// Both forms are needed because command stdout mixes shell env dumps
// (FOO=bar), HTTP request logs (Authorization: Bearer X), and JSON config
// ("api_key":"...") and the brief's redaction test asserts neither the bare
// value nor the bearer token survives.
//
// Form 2's separator deliberately does NOT consume the value's opening quote
// (the JSON alternative is "\s*:\s*" — two quotes, one closing the key, one
// opening the value). This lets the quoted-value alternatives match the value
// as a COMPLETE unit ("..."), so redaction rewrites the value in place and
// leaves the surrounding JSON structure intact and re-parseable. The bare-value
// alternative excludes quotes so it cannot reach through a closing quote and
// corrupt a following field separator.
var sensitiveCredentialPatterns = []*regexp.Regexp{
	// Form 0 (Authorization header, scheme-agnostic): an "authorization:" HTTP
	// header line redacts the ENTIRE value to end of line, regardless of scheme
	// (Basic/Bearer/Token/Negotiate/custom). Form 2's bare-value alternative
	// stops at whitespace, so "Authorization: Basic dXNlcjpwYXNz" would otherwise
	// redact only "Basic" and leak the base64 credential. This pattern runs
	// FIRST so the full header value is consumed before Form 1/2 ever see it.
	//
	// The value's first character is constrained to NOT be a quote: the JSON
	// quoted-authorization form is `{"authorization":"value"}`, where the char
	// after the colon is `"`. Excluding the leading quote lets Form 0 skip the
	// JSON form (handled structurally by Form 2, preserving JSON balance) while
	// still matching every real HTTP header value (whose first char is a scheme
	// letter). The value then runs to the end of the line ([^\r\n]*), which is
	// correct because HTTP header values are line-oriented.
	regexp.MustCompile(`(?i)(authorization)\s*:\s*([^"\r\n][^\r\n]*)`),
	// Form 1: <keyword> [:] Bearer <token>. The scheme word Bearer is optional
	// but when present the token after it is the secret. Optional colon so both
	// "Authorization: Bearer X" and "authorization bearer X" match. This now
	// only fires for the bare-token form (no colon+scheme header), since Form 0
	// already consumed the full "Authorization: Bearer X" line.
	regexp.MustCompile(`(?i)(authorization)\s*[:=]?\s*bearer\s+([^\s,]+)`),
	// Form 2: <keyword> (followed by =, :, or JSON ":") then a quoted-or-bare value.
	//   - a double-quoted JSON-style value: "..."  -> matched as a unit
	//   - a single-quoted value: '...'            -> matched as a unit
	//   - a bare value: non-whitespace, non-comma, non-quote -> up to ws/comma
	// The bare alternative excludes quotes so it never swallows a closing quote
	// of a quoted value (which would corrupt the JSON structure).
	regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*|"\s*:\s*"|'\s*:\s*')("([^"]*)"|'([^']*)'|([^\s,"']+))`),
}

// redactKeyReplacements is how each sensitive-keyword match is rewritten: the
// keyword is preserved (so the log still says WHICH secret leaked) and the
// captured value is replaced by [REDACTED]. Each pattern's replacement template
// references its capture groups in order.
//
// Pattern 0 groups: 1=keyword(authorization) 2=full header value
// Pattern 1 groups: 1=keyword 2=token
// Pattern 2 groups: 1=keyword 2=sep 3=full-value 4=dq-inner 5=sq-inner 6=bare
//
// For a JSON-string value the separator alternative "\s*:\s*" captures both
// the key-closing quote and the value-opening quote, and the bare-value
// alternative (now quote-excluding) captures the value text up to — but not
// including — the value-closing quote. So the full match span is
// "key":"value" (without the trailing quote), and the replacement
// keyword + sep + [REDACTED] yields "key":"[REDACTED]" — the unmatched
// trailing quote remains in place, keeping the JSON balanced and parseable.
// This structure-preserving behavior is asserted by
// TestRedactExecutionTextPreservesJSONStructure.
var redactKeyReplacements = []string{
	`${1}: [REDACTED]`,
	`${1}: Bearer [REDACTED]`,
	`${1}${2}[REDACTED]`,
}

// redactExecutionText masks credential values in text for the case-insensitive
// keywords api_key, token, secret, password, authorization in both the
// key=value / key:value / "key":"value" forms and the Authorization: Bearer X
// header form. The keyword is retained; only the secret value is replaced with
// [REDACTED]. It is safe to run on arbitrary text (stdout, JSON, prompts) —
// non-matching content passes through verbatim.
func redactExecutionText(text string) string {
	for i, re := range sensitiveCredentialPatterns {
		text = re.ReplaceAllString(text, redactKeyReplacements[i])
	}
	return text
}

// writeCappedArtifact writes content to path with no upstream-truncation hint.
// It is the convenience wrapper used by registrars whose content is not a
// truncated stream tail (e.g. a redacted copy of a config file): they rely on
// this function's OWN cap detection.
func writeCappedArtifact(path string, content []byte) (artifactWriteResult, error) {
	return writeCappedArtifactWithTruncationHint(path, content, false)
}

// writeCappedArtifactWithTruncationHint writes content to path, truncating to
// the newest maxTextArtifactBytes when content exceeds the cap. When truncation
// occurs the retained tail is trimmed forward to the next UTF-8 rune boundary
// (so the retained bytes always decode as valid UTF-8) and prefixed with the
// exact marker "[TRUNCATED: retained latest <N> bytes]" where N is the byte
// count of the retained ORIGINAL content (post-UTF-8 trim, pre-prefix).
//
// upstreamTruncated covers the case where the content is ALREADY a truncated
// tail whose length is at or under the cap (e.g. a streaming command that
// emitted >10 MiB: streamTailBuffer kept exactly maxStreamTailBytes and latched
// its truncated flag). In that case len <= cap is TRUE so the over-cap branch
// would NOT fire, and the stored artifact would be written verbatim with
// Truncated=false and no marker — silently dropping the head with no signal.
// When upstreamTruncated is true the content is treated as already-truncated
// regardless of length: it is stamped with the marker (N = len(content)) and
// Truncated=true, even when len <= cap. Content genuinely under the cap with
// upstreamTruncated=false is written verbatim with Truncated=false. The parent
// directory is created if missing.
func writeCappedArtifactWithTruncationHint(path string, content []byte, upstreamTruncated bool) (artifactWriteResult, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return artifactWriteResult{}, fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}

	if int64(len(content)) <= maxTextArtifactBytes && !upstreamTruncated {
		if err := os.WriteFile(path, content, 0o644); err != nil {
			return artifactWriteResult{}, fmt.Errorf("write %s: %w", path, err)
		}
		return artifactWriteResult{BytesWritten: len(content), Truncated: false}, nil
	}

	// Truncation: either content exceeds the cap (trim to the newest tail) or
	// the caller told us the head was already discarded upstream (use content
	// verbatim as the retained tail). In both cases the retained window is
	// trimmed forward to a UTF-8 rune boundary so it decodes cleanly.
	tail := content
	if int64(len(content)) > maxTextArtifactBytes {
		tail = content[int64(len(content))-maxTextArtifactBytes:]
	}
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	prefix := fmt.Sprintf(truncationPrefixFormat, len(tail))
	out := make([]byte, 0, len(prefix)+len(tail))
	out = append(out, prefix...)
	out = append(out, tail...)
	if err := os.WriteFile(path, out, 0o644); err != nil {
		return artifactWriteResult{}, fmt.Errorf("write %s: %w", path, err)
	}
	return artifactWriteResult{BytesWritten: len(out), Truncated: true}, nil
}

// artifactRegistrar is the shared boilerplate wrapper around store.CreateArtifact
// for the safe, bounded artifact-capture layer. It owns the job/step/attempt
// context so callers don't repeat the ID/summary plumbing, and it guarantees
// the operational-file-intact invariant: every register* method writes a
// REDACTED, capped COPY under the attempt audit dir and inserts an artifact row
// pointing at that copy — never at the operational source file.
type artifactRegistrar struct {
	store *store.Store
	jobID string
	step  model.JobStep
}

// registerRedactedCopy reads the operational source file at srcPath, redacts
// credentials, caps to maxTextArtifactBytes, writes the sanitized result to
// dstPath (under the attempt audit dir), and inserts an artifact row of the
// given kind pointing at dstPath. The source file is NEVER mutated and NEVER
// registered. A missing source is a no-op (best-effort: the step may have
// failed before producing output).
func (r *artifactRegistrar) registerRedactedCopy(ctx context.Context, kind, srcPath, dstPath, summary string) error {
	if r == nil || r.store == nil {
		return nil
	}
	raw, err := os.ReadFile(srcPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %s: %w", srcPath, err)
	}
	sanitized := []byte(redactExecutionText(string(raw)))
	if _, err := writeCappedArtifact(dstPath, sanitized); err != nil {
		return err
	}
	return r.store.CreateArtifact(ctx, model.Artifact{
		ID:        "art_" + id.New(),
		JobID:     r.jobID,
		StepID:    r.step.ID,
		Attempt:   r.step.Attempt,
		Kind:      kind,
		Path:      dstPath,
		Summary:   summary,
		CreatedAt: time.Now(),
	})
}

// registerCappedLog writes an audit-only command log (stdout.log/stderr.log)
// directly as a redacted, capped file at dstPath and inserts an artifact row.
// Unlike registerRedactedCopy this takes the content directly (command output is
// not an operational file on disk that must be preserved), so there is no
// separate source to read — the redacted+capped file IS the only copy.
//
// upstreamTruncated is the streaming-path hint: when the captured command
// output was truncated upstream by the streaming buffer (it emitted >10 MiB and
// only the tail was retained), the stored artifact is stamped with the
// [TRUNCATED: ...] marker + Truncated=true even though the retained bytes are
// at/under the per-artifact cap. See writeCappedArtifactWithTruncationHint.
func (r *artifactRegistrar) registerCappedLog(ctx context.Context, kind, dstPath string, content []byte, upstreamTruncated bool, summary string) error {
	if r == nil || r.store == nil {
		return nil
	}
	sanitized := []byte(redactExecutionText(string(content)))
	if _, err := writeCappedArtifactWithTruncationHint(dstPath, sanitized, upstreamTruncated); err != nil {
		return err
	}
	return r.store.CreateArtifact(ctx, model.Artifact{
		ID:        "art_" + id.New(),
		JobID:     r.jobID,
		StepID:    r.step.ID,
		Attempt:   r.step.Attempt,
		Kind:      kind,
		Path:      dstPath,
		Summary:   summary,
		CreatedAt: time.Now(),
	})
}
