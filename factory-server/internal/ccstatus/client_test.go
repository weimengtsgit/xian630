package ccstatus

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newStatusServer builds an httptest server that dispatches on the request path
// and returns canned JSON for the cc-status endpoints. The handlers can be
// overridden per-test by passing nil to keep the default responders.
func newStatusServer(t *testing.T, healthHandler, agentsHandler, skillsHandler http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	if healthHandler != nil {
		mux.HandleFunc("/healthz", healthHandler)
	} else {
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
			writeRaw(w, http.StatusOK, `{"ok":true,"version":"test"}`)
		})
	}
	if agentsHandler != nil {
		mux.HandleFunc("/api/v1/agents", agentsHandler)
	} else {
		mux.HandleFunc("/api/v1/agents", func(w http.ResponseWriter, r *http.Request) {
			writeRaw(w, http.StatusOK, `[{"id":"sa_1","session_id":"s1","agent_id":"a1","agent_type":"code-generator","status":"running","started_at":"2026-06-18T10:00:00Z","ended_at":"","description":"gen","model":"sonnet"}]`)
		})
	}
	if skillsHandler != nil {
		mux.HandleFunc("/api/v1/skills", skillsHandler)
	} else {
		mux.HandleFunc("/api/v1/skills", func(w http.ResponseWriter, r *http.Request) {
			writeRaw(w, http.StatusOK, `[{"id":"sk_1","session_id":"s1","agent_id":"a1","name":"tdd","source":"builtin","status":"running"}]`)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func writeRaw(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprint(w, body)
}

func TestHealthOK(t *testing.T) {
	srv := newStatusServer(t, nil, nil, nil)
	c := Client{BaseURL: srv.URL}

	if err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health err = %v, want nil", err)
	}
}

func TestHealthFailsOn500(t *testing.T) {
	srv := newStatusServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusInternalServerError, `{"ok":false}`)
	}, nil, nil)
	c := Client{BaseURL: srv.URL}

	err := c.Health(context.Background())
	if err == nil {
		t.Fatalf("Health err = nil, want non-nil")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Health err = %v, want errors.Is ErrUnavailable", err)
	}
}

func TestHealthUnreachable(t *testing.T) {
	// A port that is almost certainly not listening. The connection error must
	// be wrapped with ErrUnavailable.
	c := Client{BaseURL: "http://127.0.0.1:1", HTTP: &http.Client{Timeout: shortTimeout}}

	err := c.Health(context.Background())
	if err == nil {
		t.Fatalf("Health err = nil, want non-nil")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Health err = %v, want errors.Is ErrUnavailable", err)
	}
}

func TestListAgents(t *testing.T) {
	srv := newStatusServer(t, nil, func(w http.ResponseWriter, r *http.Request) {
		// The status query param should be echoed in the request.
		if got := r.URL.Query().Get("status"); got != "running" {
			t.Errorf("status query = %q, want running", got)
		}
		writeRaw(w, http.StatusOK, `[
			{"id":"sa_1","session_id":"s1","agent_id":"a1","agent_type":"code-generator","status":"running","started_at":"2026-06-18T10:00:00Z"},
			{"id":"sa_2","session_id":"s2","agent_id":"a2","agent_type":"tester","status":"running","started_at":"2026-06-18T10:01:00Z"}
		]`)
	}, nil)
	c := Client{BaseURL: srv.URL}

	agents, err := c.ListAgents(context.Background(), "running")
	if err != nil {
		t.Fatalf("ListAgents err = %v", err)
	}
	if len(agents) != 2 {
		t.Fatalf("len = %d, want 2", len(agents))
	}
	if agents[0].ID != "sa_1" || agents[0].AgentType != "code-generator" {
		t.Fatalf("agent[0] = %+v", agents[0])
	}
	if agents[1].Status != "running" {
		t.Fatalf("agent[1].status = %q", agents[1].Status)
	}
}

func TestListAgentsUnavailable(t *testing.T) {
	srv := newStatusServer(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusServiceUnavailable, `{"error":"down"}`)
	}, nil)
	c := Client{BaseURL: srv.URL}

	_, err := c.ListAgents(context.Background(), "running")
	if err == nil {
		t.Fatalf("ListAgents err = nil, want non-nil")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("ListAgents err = %v, want errors.Is ErrUnavailable", err)
	}
}

func TestListAgentsUnreachable(t *testing.T) {
	c := Client{BaseURL: "http://127.0.0.1:1", HTTP: &http.Client{Timeout: shortTimeout}}

	_, err := c.ListAgents(context.Background(), "running")
	if err == nil {
		t.Fatalf("ListAgents err = nil, want non-nil")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("ListAgents err = %v, want errors.Is ErrUnavailable", err)
	}
}

func TestListAgentsBadJSON(t *testing.T) {
	srv := newStatusServer(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusOK, `not json`)
	}, nil)
	c := Client{BaseURL: srv.URL}

	_, err := c.ListAgents(context.Background(), "")
	if err == nil {
		t.Fatalf("ListAgents err = nil, want non-nil for bad json")
	}
}

func TestListSkills(t *testing.T) {
	srv := newStatusServer(t, nil, nil, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("status"); got != "running" {
			t.Errorf("status query = %q, want running", got)
		}
		writeRaw(w, http.StatusOK, `[{"id":"sk_1","session_id":"s1","agent_id":"a1","name":"tdd","source":"builtin","status":"running"}]`)
	})
	c := Client{BaseURL: srv.URL}

	skills, err := c.ListSkills(context.Background(), "running")
	if err != nil {
		t.Fatalf("ListSkills err = %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("len = %d, want 1", len(skills))
	}
	if skills[0].Name != "tdd" || skills[0].Source != "builtin" {
		t.Fatalf("skill[0] = %+v", skills[0])
	}
}

func TestListSkillsUnavailable(t *testing.T) {
	// A server that 503s on skills, leaving the other endpoints healthy.
	srv := newStatusServer(t, nil, nil, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusServiceUnavailable, `{"error":"down"}`)
	})
	c := Client{BaseURL: srv.URL}

	_, err := c.ListSkills(context.Background(), "running")
	if err == nil {
		t.Fatalf("ListSkills err = nil, want non-nil")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("ListSkills err = %v, want errors.Is ErrUnavailable", err)
	}
}

// TestDefaultHTTPClientTimeout verifies that a Client with HTTP == nil uses the
// package-level short default timeout so a hung cc-status cannot stall callers.
func TestDefaultHTTPClientTimeout(t *testing.T) {
	c := Client{BaseURL: "http://127.0.0.1:1"} // unreachable, no HTTP set
	if hc := c.httpClient(); hc.Timeout != shortTimeout {
		t.Fatalf("default timeout = %v, want %v", hc.Timeout, shortTimeout)
	}
	// And Health must return promptly (not hang) for an unreachable host.
	if err := c.Health(context.Background()); err == nil {
		t.Fatalf("Health err = nil, want non-nil for unreachable host")
	}
}

// Make sure a JSON array decode does not choke when cc-status returns an empty
// array.
func TestListAgentsEmpty(t *testing.T) {
	srv := newStatusServer(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, http.StatusOK, `[]`)
	}, nil)
	c := Client{BaseURL: srv.URL}

	agents, err := c.ListAgents(context.Background(), "running")
	if err != nil {
		t.Fatalf("ListAgents err = %v", err)
	}
	if agents == nil || len(agents) != 0 {
		t.Fatalf("agents = %v, want non-nil empty slice", agents)
	}
}

// guard against accidental removal of the only fmt use.
var _ = fmt.Sprint
