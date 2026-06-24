package runner

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Console tracing for the Claude Code CLI invocations. When FACTORY_LLM_CONSOLE
// is truthy, every claude --print call prints its request (prompt + argv) and
// its streamed response (assistant thinking/text/tool_use blocks + final
// result) to stderr, so a demo/operator can watch the model interaction live in
// the server console. It is strictly an observer: the trace helpers swallow all
// decode errors and never return failures, so enabling the trace cannot change
// the outcome of a run. Default off keeps test output quiet and avoids flooding
// a production console.
var (
	llmConsoleOnce    sync.Once
	llmConsoleEnabled bool
)

// LLMConsoleEnabled reports whether request/response console tracing is on. The
// env var is read once (sync.Once) so the per-line streaming callback does not
// re-query os.Getenv for every line of a long run.
func LLMConsoleEnabled() bool {
	llmConsoleOnce.Do(func() {
		switch strings.ToLower(strings.TrimSpace(os.Getenv("FACTORY_LLM_CONSOLE"))) {
		case "1", "true", "yes", "on":
			llmConsoleEnabled = true
		}
	})
	return llmConsoleEnabled
}

// LLMConsoleRequest prints the request side of one Claude CLI invocation: a
// banner with the stage label, the full argv, and the prompt text. This is the
// "请求" half of the trace. No-op unless LLMConsoleEnabled().
func LLMConsoleRequest(stage, binary string, args []string, prompt string) {
	if !LLMConsoleEnabled() {
		return
	}
	fmt.Fprintf(os.Stderr, "\n==================== [ %s ] claude request ====================\n", strings.ToUpper(stage))
	fmt.Fprintf(os.Stderr, "$ %s %s\n", binary, strings.Join(args, " "))
	fmt.Fprintf(os.Stderr, "--- prompt ---\n%s\n", prompt)
	fmt.Fprintf(os.Stderr, "===============================================================================\n")
}

// LLMConsoleStreamLine prints one Claude stream-json NDJSON line in a readable
// form — the "返回" half of the trace, streamed line by line as the CLI emits
// it. It renders assistant thinking/text/tool_use blocks and the final result
// event; system/user lines and --include-partial-messages partials
// (stream_event) are ignored, because the complete assistant turn that follows
// a run of partials carries the full content (matching streamClaudeEvents).
// Malformed or non-JSON lines are silently dropped: tracing must never break
// the real call.
func LLMConsoleStreamLine(line string) {
	if !LLMConsoleEnabled() {
		return
	}
	line = strings.TrimSpace(line)
	if line == "" || !strings.HasPrefix(line, "{") {
		return
	}
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type     string         `json:"type"`
				Text     string         `json:"text"`
				Thinking string         `json:"thinking"`
				Name     string         `json:"name"`
				Input    map[string]any `json:"input"`
			} `json:"content"`
		} `json:"message"`
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return
	}
	switch ev.Type {
	case "assistant":
		for _, b := range ev.Message.Content {
			switch b.Type {
			case "thinking":
				if t := strings.TrimSpace(b.Thinking); t != "" {
					fmt.Fprintf(os.Stderr, "\n[thinking]\n%s\n", indentBlock(t))
				}
			case "text":
				if t := strings.TrimSpace(b.Text); t != "" {
					fmt.Fprintf(os.Stderr, "\n[assistant] %s\n", t)
				}
			case "tool_use":
				fmt.Fprintf(os.Stderr, "  [tool] %s%s\n", b.Name, toolUseInputSummary(b.Input))
			}
		}
	case "result":
		label := "[result]"
		if ev.IsError {
			label = "[result:error]"
		}
		fmt.Fprintf(os.Stderr, "\n%s %s\n", label, strings.TrimSpace(ev.Result))
	}
}

// LLMConsoleStderr prints one stderr line from a Claude invocation verbatim.
// stderr is not stream-json; it carries CLI diagnostics (auth errors, upstream
// API 529s, deprecation notices) that matter in a trace and would otherwise be
// invisible because the streaming stdout path only renders NDJSON. No-op unless
// LLMConsoleEnabled().
func LLMConsoleStderr(line string) {
	if !LLMConsoleEnabled() {
		return
	}
	if strings.TrimSpace(line) == "" {
		return
	}
	fmt.Fprintf(os.Stderr, "[stderr] %s\n", line)
}

// indentBlock prefixes every line of s with two spaces so a multi-line thinking
// trace reads as a quoted block under the [thinking] header.
func indentBlock(s string) string {
	var b strings.Builder
	for i, line := range strings.Split(s, "\n") {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("  ")
		b.WriteString(line)
	}
	return b.String()
}

// toolUseInputSummary renders the path/pattern argument of a tool_use input as a
// short, redacted suffix for the [tool] line (e.g. "Write generated-apps/.../App.jsx").
// Reuses redactPath so the console never leaks the operator's absolute home/repo path.
func toolUseInputSummary(input map[string]any) string {
	if input == nil {
		return ""
	}
	for _, key := range []string{"file_path", "path", "pattern"} {
		if v, ok := input[key].(string); ok && v != "" {
			return " " + redactPath(v)
		}
	}
	return ""
}
