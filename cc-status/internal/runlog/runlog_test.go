package runlog

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoggerAppendsJSONLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "events.jsonl")
	l := New(path, 1024, 2)

	l.Event("server_started", map[string]any{"addr": "127.0.0.1:8765"})
	l.Event("hook_ingested", map[string]any{"session_id": "sess_1"})

	lines := readLines(t, path)
	if len(lines) != 2 {
		t.Fatalf("line count = %d, want 2", len(lines))
	}
	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("first line is not json: %v", err)
	}
	if first["event"] != "server_started" || first["addr"] != "127.0.0.1:8765" || first["ts"] == "" {
		t.Fatalf("first event = %#v", first)
	}
}

func TestLoggerRotatesBySize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	l := New(path, 120, 2)

	l.Event("large_event", map[string]any{"payload": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	l.Event("large_event", map[string]any{"payload": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	l.Event("large_event", map[string]any{"payload": "cccccccccccccccccccccccccccccccccccccccc"})

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("current log missing: %v", err)
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("first rotated log missing: %v", err)
	}
	if _, err := os.Stat(path + ".2"); err != nil {
		t.Fatalf("second rotated log missing: %v", err)
	}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return out
}
