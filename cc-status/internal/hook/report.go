package hook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// Report posts the parsed event to the cc-status server. It is best-effort: on
// any error it writes a short note to stderr and returns nil so the hook
// process always exits cleanly and never blocks Claude Code.
//
// Observational contract: callers must exit 0 with empty stdout. Report never
// writes to stdout.
func Report(serverURL, ingestPath string, e *Event) error {
	body := e.Raw
	if len(body) == 0 {
		b, err := json.Marshal(e)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cc-status hook: marshal: %v\n", err)
			return nil
		}
		body = b
	}

	url := serverURL + ingestPath
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "cc-status hook: post %s: %v\n", url, err)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "cc-status hook: server returned %s\n", resp.Status)
	}
	return nil
}
