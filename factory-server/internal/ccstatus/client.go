// Package ccstatus is a thin read-only HTTP client for the cc-status
// observation service. cc-status runs as a separate process on the host and
// exposes the live state of Claude Code subagents and skills. It is an OPTIONAL
// dependency: every method returns an error on any failure and callers MUST
// degrade gracefully (never fail a job/app/agent request because cc-status is
// unreachable). The sentinel ErrUnavailable (aliased to the shared
// model.ErrorCCStatusUnavailable code) makes that detectable via errors.Is.
package ccstatus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// shortTimeout caps how long a single cc-status request may take when the
// caller has not supplied its own *http.Client. cc-status is best-effort
// observability, so we never block a job for it.
const shortTimeout = 2 * time.Second

// ErrUnavailable is returned (wrapped) for any cc-status failure: a network
// error, a non-2xx status, or a decode error. It aliases the shared error code
// so callers can record model.ErrorCCStatusUnavailable uniformly.
var ErrUnavailable = errors.New(string(model.ErrorCCStatusUnavailable))

// Client talks to a cc-status instance. Both fields are safe to leave zero;
// tests inject a short-timeout (or httptest-pointing) *http.Client.
type Client struct {
	BaseURL string
	HTTP    *http.Client // default: a client with ShortTimeout; nil-safe
}

// Subagent is a subset of the cc-status /api/v1/agents row.
type Subagent struct {
	ID          string `json:"id"`
	SessionID   string `json:"session_id"`
	AgentID     string `json:"agent_id"`
	AgentType   string `json:"agent_type"`
	Description string `json:"description"`
	Status      string `json:"status"`
	Model       string `json:"model"`
	StartedAt   string `json:"started_at"`
	EndedAt     string `json:"ended_at"`
}

// Skill is a subset of the cc-status /api/v1/skills row.
type Skill struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	AgentID   string `json:"agent_id"`
	Name      string `json:"name"`
	Source    string `json:"source"`
	Status    string `json:"status"`
}

// httpClient returns the configured client or a short-timeout default.
func (c Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: shortTimeout}
}

// Health probes GET {BaseURL}/healthz. It returns nil only when cc-status
// responds with a 2xx; any other outcome is wrapped with ErrUnavailable.
func (c Client) Health(ctx context.Context) error {
	return c.get(ctx, "/healthz", nil, nil)
}

// ListAgents calls GET {BaseURL}/api/v1/agents?status=<status> and decodes the
// returned JSON array. An empty status omits the query parameter.
func (c Client) ListAgents(ctx context.Context, status string) ([]Subagent, error) {
	var out []Subagent
	if err := c.get(ctx, "/api/v1/agents", map[string]string{"status": status}, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []Subagent{}
	}
	return out, nil
}

// ListSkills calls GET {BaseURL}/api/v1/skills?status=<status> and decodes the
// returned JSON array. An empty status omits the query parameter.
func (c Client) ListSkills(ctx context.Context, status string) ([]Skill, error) {
	var out []Skill
	if err := c.get(ctx, "/api/v1/skills", map[string]string{"status": status}, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []Skill{}
	}
	return out, nil
}

// get is the single request path. It builds the URL, attaches optional query
// params, executes the request, and (when into != nil) decodes a JSON body.
// Every failure path wraps the error with ErrUnavailable so callers can detect
// it via errors.Is.
func (c Client) get(ctx context.Context, path string, params map[string]string, into any) error {
	u, err := url.JoinPath(c.BaseURL, path)
	if err != nil {
		return fmt.Errorf("cc-status url: %w", ErrUnavailable)
	}
	if len(params) > 0 {
		q := url.Values{}
		for k, v := range params {
			if v == "" {
				continue
			}
			q.Set(k, v)
		}
		if enc := q.Encode(); enc != "" {
			u = u + "?" + enc
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return fmt.Errorf("cc-status request: %w", ErrUnavailable)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("cc-status request: %w", errors.Join(err, ErrUnavailable))
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("cc-status status %d: %w", resp.StatusCode, ErrUnavailable)
	}
	if into == nil {
		// Drain so the connection can be reused, but we have nothing to decode.
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		return fmt.Errorf("cc-status decode: %w", errors.Join(err, ErrUnavailable))
	}
	return nil
}
