package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// TestRedactExecutionTextMasksCredentials is the brief's required test: an
// input carrying a key=value secret AND an Authorization: Bearer header must
// leak neither the value nor the bearer token, and must contain [REDACTED].
func TestRedactExecutionTextMasksCredentials(t *testing.T) {
	got := redactExecutionText("ANTHROPIC_API_KEY=secret Authorization: Bearer abc")
	if strings.Contains(got, "secret") || strings.Contains(got, "abc") {
		t.Fatalf("credential leaked: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("got %q", got)
	}
}

// TestRedactExecutionTextMasksAllSensitiveKeysAndPreservesOtherContent
// exercises every keyword the brief names (case-insensitive) in both the
// key=value and header forms, and verifies non-secret prose survives untouched.
func TestRedactExecutionTextMasksAllSensitiveKeysAndPreservesOtherContent(t *testing.T) {
	in := "build ok\n" +
		"DB_PASSWORD=hunter2\n" +
		"x-api-key: s3cretvalue\n" +
		"refresh_token=tok-123\n" +
		"client_secret=cs-456\n" +
		"authorization: bearer abc.def.ghi\n" +
		"normal line keeps its words\n"
	got := redactExecutionText(in)
	for _, leak := range []string{"hunter2", "s3cretvalue", "tok-123", "cs-456", "abc.def.ghi"} {
		if strings.Contains(got, leak) {
			t.Errorf("leaked %q in %q", leak, got)
		}
	}
	for _, keep := range []string{"build ok", "DB_PASSWORD", "normal line keeps its words", "[REDACTED]"} {
		if !strings.Contains(got, keep) {
			t.Errorf("lost %q in %q", keep, got)
		}
	}
}

// TestRedactExecutionTextPreservesJSONStructure is the Task-2 Fix-1 regression:
// redacting a JSON-form credential value must NOT corrupt the surrounding JSON
// structure. The audit copy is meant to be a displayable, parseable sanitized
// copy, so the redacted output must (a) leak no secret, (b) still be valid JSON,
// and (c) still contain [REDACTED]. Covers both compact and spaced JSON-string
// values and a mix with the already-working shell/env forms to prove no
// regression of the working KEY=value form.
func TestRedactExecutionTextPreservesJSONStructure(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"json compact", `{"api_key":"hunter2"}`},
		{"json spaced", `{"token": "tok-1"}`},
		{"json two fields compact", `{"api_key":"hunter2","token":"tok-1"}`},
		{"json with non-secret sibling", `{"api_key":"hunter2","other":"keep-me","token":"x"}`},
		{"json nested", `{"config":{"secret":"nest-secret"},"ok":1}`},
		// Mix with the already-working forms to prove no regression.
		{"shell form", "ANTHROPIC_API_KEY=hunter2"},
		{"shell form from brief", "DB_PASSWORD=hunter2-leak"},
		{"header form", "Authorization: Bearer leak-xyz"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := redactExecutionText(c.in)

			// (a) No leaked secret. Check every planted secret value.
			for _, secret := range extractPlantedSecrets(c.in) {
				if strings.Contains(got, secret) {
					t.Fatalf("secret %q leaked in %q", secret, got)
				}
			}
			// (c) [REDACTED] present.
			if !strings.Contains(got, "[REDACTED]") {
				t.Fatalf("[REDACTED] missing in %q", got)
			}
			// (b) JSON-form inputs must still parse as valid JSON.
			if strings.HasPrefix(strings.TrimSpace(c.in), "{") {
				var v map[string]any
				if err := json.Unmarshal([]byte(got), &v); err != nil {
					t.Fatalf("redacted JSON is not parseable: %v\ninput : %s\noutput: %s", err, c.in, got)
				}
			}
		})
	}
}

// extractPlantedSecrets pulls every credential VALUE out of a known-shape test
// input so the leak assertion checks each one. It understands the JSON
// `"sensitiveKey":"value"` form, the KEY=value shell form, and the
// "Authorization: Bearer X" header form used by the cases above. For JSON it
// walks every key/value pair; for the shell/header forms it returns the value.
func extractPlantedSecrets(in string) []string {
	in = strings.TrimSpace(in)
	if strings.HasPrefix(in, "{") {
		var m map[string]json.RawMessage
		if err := json.Unmarshal([]byte(in), &m); err != nil {
			return nil
		}
		sensitive := map[string]bool{
			"api_key": true, "token": true, "secret": true,
			"password": true, "authorization": true,
		}
		var out []string
		var walk func(v json.RawMessage)
		walk = func(v json.RawMessage) {
			// Nested object?
			var nested map[string]json.RawMessage
			if err := json.Unmarshal(v, &nested); err == nil {
				for k, vv := range nested {
					if sensitive[strings.ToLower(k)] {
						if s := rawString(vv); s != "" {
							out = append(out, s)
						}
					} else {
						walk(vv)
					}
				}
				return
			}
		}
		for k, v := range m {
			if sensitive[strings.ToLower(k)] {
				if s := rawString(v); s != "" {
					out = append(out, s)
				}
			} else {
				walk(v)
			}
		}
		return out
	}
	// Authorization: Bearer X
	if low := strings.ToLower(in); strings.HasPrefix(low, "authorization") {
		if i := strings.Index(low, "bearer "); i >= 0 {
			return []string{strings.TrimSpace(in[i+len("bearer "):])}
		}
	}
	// KEY=value
	if eq := strings.Index(in, "="); eq >= 0 {
		return []string{strings.TrimSpace(in[eq+1:])}
	}
	return nil
}

// rawString unwraps a JSON string raw message to its value, or "" if not a string.
func rawString(v json.RawMessage) string {
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return ""
	}
	return s
}

// TestRedactExecutionTextMasksFullAuthorizationHeader is the F4 regression: the
// bare-value alternative in Form 2 stops at whitespace, so an Authorization
// header whose value has a scheme word (Basic/Token/Negotiate/Bearer/custom)
// followed by the real credential must NOT leak the credential after the scheme
// word. The WHOLE header value is redacted regardless of scheme, while the JSON
// quoted-authorization form remains structurally intact (handled by Form 2).
func TestRedactExecutionTextMasksFullAuthorizationHeader(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		leaks []string // none of these substrings may survive
	}{
		{"basic header", "Authorization: Basic dXNlcjpwYXNz", []string{"dXNlcjpwYXNz", "Basic dXNlcjpwYXNz"}},
		{"token header", "Authorization: Token abc-123", []string{"abc-123", "Token abc-123"}},
		{"negotiate header", "Authorization: Negotiate xyz", []string{"xyz", "Negotiate xyz"}},
		{"bearer header still works", "Authorization: Bearer leak-xyz", []string{"leak-xyz", "Bearer leak-xyz"}},
		{"custom scheme header", "Authorization: MyScheme s3cretval", []string{"s3cretval"}},
		{"header embedded in log", "GET /v1\nAuthorization: Basic dXNlcjpwYXNz\naccept: */*", []string{"dXNlcjpwYXNz"}},
		{"lowercase header", "authorization: basic dXNlcjpwYXNz", []string{"dXNlcjpwYXNz"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := redactExecutionText(c.in)
			if !strings.Contains(got, "[REDACTED]") {
				t.Fatalf("[REDACTED] missing in %q", got)
			}
			for _, leak := range c.leaks {
				if strings.Contains(got, leak) {
					t.Fatalf("credential leaked %q in %q", leak, got)
				}
			}
		})
	}
}

// TestRedactExecutionTextAuthorizationHeaderPreservesJSONAuthorization ensures
// the broad header redaction does NOT corrupt the JSON-quoted authorization
// field handled structurally by Form 2. A JSON `"authorization":"...":` value
// must stay balanced/parseable after redaction.
func TestRedactExecutionTextAuthorizationHeaderPreservesJSONAuthorization(t *testing.T) {
	in := `{"authorization":"should-be-redacted","other":"keep"}`
	got := redactExecutionText(in)
	if strings.Contains(got, "should-be-redacted") {
		t.Fatalf("json authorization value leaked: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("[REDACTED] missing: %q", got)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(got), &v); err != nil {
		t.Fatalf("redacted JSON is not parseable: %v (got %q)", err, got)
	}
	if _, ok := v["other"]; !ok {
		t.Fatalf("sibling field lost: %q", got)
	}
}

// TestWriteCappedArtifactKeepsNewestBytes is the brief's required test: when
// content exceeds the cap, the file keeps the tail ("tail") and Truncated=true.
func TestWriteCappedArtifactKeepsNewestBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stdout.log")
	result, err := writeCappedArtifact(path, []byte(strings.Repeat("a", int(maxTextArtifactBytes))+"tail"))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !result.Truncated || !bytes.Contains(raw, []byte("tail")) {
		t.Fatalf("result=%+v", result)
	}
}

// TestWriteCappedArtifactSubCapIsVerbatim asserts a sub-cap write is byte-for-byte
// verbatim and reports Truncated=false.
func TestWriteCappedArtifactSubCapIsVerbatim(t *testing.T) {
	content := []byte("short verbatim content with no truncation")
	path := filepath.Join(t.TempDir(), "stdout.log")
	result, err := writeCappedArtifact(path, content)
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncated {
		t.Fatalf("Truncated=true for sub-cap write: %+v", result)
	}
	raw, _ := os.ReadFile(path)
	if !bytes.Equal(raw, content) {
		t.Fatalf("sub-cap write not verbatim: got %q want %q", raw, content)
	}
}

// TestWriteCappedArtifactTailIsUTF8SafeAtBoundary ensures the retained tail is
// UTF-8-decodable even when the cap cuts in the middle of a multi-byte rune.
// We craft a payload whose cut point would split a 3-byte rune; the tail must
// start on a rune boundary and decode cleanly.
func TestWriteCappedArtifactTailIsUTF8SafeAtBoundary(t *testing.T) {
	// 3-byte rune '中' (E4 B8 AD) repeated. Build a payload that is exactly cap+1.
	rune3 := []byte("中") // 3 bytes
	// Fill up to exactly the cap, then append one extra byte beyond cap so
	// truncation triggers and the cap boundary lands inside a rune.
	fill := make([]byte, 0, int(maxTextArtifactBytes)+1)
	// Add whole 3-byte runes until we are one byte shy of the cap, then add a
	// full rune so the (cap+0)th byte is the middle byte of that rune.
	for int64(len(fill))+3 <= maxTextArtifactBytes {
		fill = append(fill, rune3...)
	}
	// Pad with single bytes until we reach exactly the cap.
	for int64(len(fill)) < maxTextArtifactBytes {
		fill = append(fill, 'a')
	}
	// Append one more full rune so content exceeds the cap and the cap-cut
	// boundary itself is mid-rune in the retained window start only if we
	// weren't lucky with alignment — the helper must guarantee UTF-8 safety
	// regardless.
	fill = append(fill, rune3...)
	// Append a clean ascii tail so we can assert it survives.
	fill = append(fill, []byte("END")...)

	path := filepath.Join(t.TempDir(), "stdout.log")
	result, err := writeCappedArtifact(path, fill)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated {
		t.Fatalf("expected Truncated=true")
	}
	raw, _ := os.ReadFile(path)
	if !bytes.HasSuffix(raw, []byte("END")) {
		t.Fatalf("tail END missing: ...%q", tailBytes(raw, 16))
	}
	// Drop the truncation prefix, then the remainder must be valid UTF-8.
	wantPrefix := "[TRUNCATED: retained latest 10485760 bytes]"
	body := bytes.TrimPrefix(raw, []byte(wantPrefix))
	if !utf8.Valid(body) {
		t.Fatalf("retained tail is not valid UTF-8 at start: %x...", headBytes(body, 16))
	}
}

// TestWriteCappedArtifactPrefixIsExact verifies the truncation marker carries
// the exact retained byte count from the brief, verbatim.
func TestWriteCappedArtifactPrefixIsExact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stdout.log")
	_, err := writeCappedArtifact(path, []byte(strings.Repeat("x", int(maxTextArtifactBytes)+10)))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	wantPrefix := []byte("[TRUNCATED: retained latest 10485760 bytes]")
	if !bytes.HasPrefix(raw, wantPrefix) {
		t.Fatalf("prefix = %q, want %q", tailBytes(raw, 60), wantPrefix)
	}
}

// TestWriteCappedArtifactUpstreamTruncationHintIsStamped is the F7 regression:
// when a streaming command emitted >10 MiB, streamTailBuffer kept exactly the
// cap and latched its truncated flag. The retained content length is AT the cap,
// so the plain over-cap branch (len <= cap → verbatim) would NOT fire and the
// stored artifact would be written with no marker and Truncated=false — silently
// dropping the head with no signal. The upstream-truncation hint overrides that:
// content at/under the cap is STILL stamped with the [TRUNCATED: ...] marker and
// Truncated=true when the caller says the head was already discarded upstream.
func TestWriteCappedArtifactUpstreamTruncationHintIsStamped(t *testing.T) {
	// Content is EXACTLY at the cap (the streaming buffer's retained tail).
	// maxTextArtifactBytes == deploy.maxStreamTailBytes (both 10 MiB).
	content := bytes.Repeat([]byte("y"), int(maxTextArtifactBytes))
	path := filepath.Join(t.TempDir(), "stdout.log")
	result, err := writeCappedArtifactWithTruncationHint(path, content, true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated {
		t.Fatalf("Truncated=false with upstream hint at-cap content")
	}
	raw, _ := os.ReadFile(path)
	wantPrefix := []byte("[TRUNCATED: retained latest 10485760 bytes]")
	if !bytes.HasPrefix(raw, wantPrefix) {
		t.Fatalf("prefix = %q, want %q", tailBytes(raw, 60), wantPrefix)
	}
	// The retained body after the prefix must be exactly the (already-tail)
	// content, byte-for-byte — no further trimming because it is already at cap.
	body := bytes.TrimPrefix(raw, wantPrefix)
	if !bytes.Equal(body, content) {
		t.Fatalf("body len = %d, want %d (at-cap tail should be kept verbatim)", len(body), len(content))
	}
}

// TestWriteCappedArtifactNoHintUnderCapStaysVerbatim is the F7 negative case:
// a sub-cap stream with no upstream-truncation hint still writes verbatim with
// Truncated=false and NO marker.
func TestWriteCappedArtifactNoHintUnderCapStaysVerbatim(t *testing.T) {
	content := []byte("small command output, well under the cap")
	path := filepath.Join(t.TempDir(), "stdout.log")
	result, err := writeCappedArtifactWithTruncationHint(path, content, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncated {
		t.Fatalf("Truncated=true for under-cap no-hint write")
	}
	raw, _ := os.ReadFile(path)
	if !bytes.Equal(raw, content) {
		t.Fatalf("under-cap write not verbatim: got %q want %q", raw, content)
	}
	if bytes.HasPrefix(raw, []byte("[TRUNCATED")) {
		t.Fatalf("under-cap write got a truncation marker: %q", raw)
	}
}

// TestRegisterCappedLogPropagatesUpstreamTruncationToArtifact drives the full
// factory writeLogs→registerCappedLog path: an upstream-truncated stdout
// (StdoutTruncated=true on the CommandResult) must produce a stored
// command_stdout artifact that begins with the [TRUNCATED: ...] marker.
func TestRegisterCappedLogPropagatesUpstreamTruncationToArtifact(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	wsDir := t.TempDir()
	reg := &artifactRegistrar{
		store: st,
		jobID: "job_f7",
		step:  model.JobStep{ID: "step_f7", Attempt: 1},
	}
	dst := filepath.Join(wsDir, "stdout.log")
	// A retained tail exactly at the streaming cap, flagged upstream-truncated.
	tail := bytes.Repeat([]byte("z"), int(maxTextArtifactBytes))
	if err := reg.registerCappedLog(context.Background(), "command_stdout", dst, tail, true, "stdout"); err != nil {
		t.Fatalf("registerCappedLog: %v", err)
	}
	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := []byte("[TRUNCATED: retained latest 10485760 bytes]")
	if !bytes.HasPrefix(raw, wantPrefix) {
		t.Fatalf("stored artifact missing truncation marker: %q", tailBytes(raw, 60))
	}
}

// TestArtifactRegistrarRegistersSanitizedCopy verifies the registrar writes a
// redacted+capped audit copy under the audit subdir and inserts an artifact row
// pointing at that copy (never at the source path).
func TestArtifactRegistrarRegistersSanitizedCopy(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	wsDir := t.TempDir()
	srcPath := filepath.Join(wsDir, "input.json")
	secret := `{"ANTHROPIC_API_KEY":"leak-me"}`
	if err := os.WriteFile(srcPath, []byte(secret), 0o644); err != nil {
		t.Fatal(err)
	}

	reg := &artifactRegistrar{
		store: st,
		jobID: "job_reg_1",
		step:  model.JobStep{ID: "step_reg_1", Attempt: 2},
	}
	auditDir := filepath.Join(wsDir, "audit")
	if err := os.MkdirAll(auditDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := reg.registerRedactedCopy(context.Background(), "input_json", srcPath, filepath.Join(auditDir, "input.json"), "test copy"); err != nil {
		t.Fatalf("register: %v", err)
	}

	// The audit copy must be redacted.
	auditRaw, err := os.ReadFile(filepath.Join(auditDir, "input.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(auditRaw, []byte("leak-me")) {
		t.Fatalf("audit copy leaked secret: %s", auditRaw)
	}
	if !bytes.Contains(auditRaw, []byte("[REDACTED]")) {
		t.Fatalf("audit copy missing [REDACTED]: %s", auditRaw)
	}
	// The source must be byte-for-byte intact.
	srcRaw, _ := os.ReadFile(srcPath)
	if string(srcRaw) != secret {
		t.Fatalf("source mutated: %q", srcRaw)
	}
	// An artifact row exists pointing at the audit copy, not the source.
	arts, err := st.ListArtifactsByJob(context.Background(), "job_reg_1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(arts) != 1 || arts[0].Kind != "input_json" {
		t.Fatalf("artifact = %+v", arts)
	}
	if arts[0].Path == srcPath {
		t.Fatalf("registered source path instead of audit copy")
	}
	if !strings.HasSuffix(filepath.ToSlash(arts[0].Path), "/audit/input.json") {
		t.Fatalf("artifact path = %q, want under .../audit/input.json", arts[0].Path)
	}
	if arts[0].Attempt != 2 {
		t.Fatalf("attempt = %d, want 2", arts[0].Attempt)
	}
}

// tailBytes/headBytes are tiny test-local helpers.
func tailBytes(b []byte, n int) []byte {
	if len(b) <= n {
		return b
	}
	return b[len(b)-n:]
}

func headBytes(b []byte, n int) []byte {
	if len(b) <= n {
		return b
	}
	return b[:n]
}
