package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/agents"
	"github.com/weimengtsgit/xian630/factory-server/internal/ccstatus"
	"github.com/weimengtsgit/xian630/factory-server/internal/config"
	"github.com/weimengtsgit/xian630/factory-server/internal/model"
	"github.com/weimengtsgit/xian630/factory-server/internal/scanner"
	"github.com/weimengtsgit/xian630/factory-server/internal/store"
)

// newAgentTestServer builds a Server + router backed by a fresh in-memory store
// seeded with the default agent registry (production startup upserts the same
// registry in Start, which the test does not invoke).
func newAgentTestServer(t *testing.T) (*Server, *Router) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	for _, a := range agents.DefaultRegistry() {
		if err := st.UpsertAgent(context.Background(), a); err != nil {
			t.Fatalf("seed agent %s: %v", a.Key, err)
		}
	}

	srv := New(config.Config{}, st, scanner.Scanner{})
	return srv, srv.routes()
}

func TestListAgents(t *testing.T) {
	_, r := newAgentTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var got []model.Agent
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 6 {
		t.Fatalf("len = %d, want 6", len(got))
	}
	keys := map[string]bool{}
	for _, a := range got {
		keys[a.Key] = true
	}
	for _, k := range []string{"requirement-analyst", "solution-designer", "code-generator", "tester", "image-builder", "deployer"} {
		if !keys[k] {
			t.Fatalf("missing agent key %s", k)
		}
	}
	// Agents should be ordered by sort_order ascending.
	if got[0].SortOrder != 1 || got[5].SortOrder != 6 {
		t.Fatalf("sort order not ascending: first=%d last=%d", got[0].SortOrder, got[5].SortOrder)
	}
}

func TestCreateAgent(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{
		"key":"review-agent",
		"name":"评审智能体",
		"role":"reviewer",
		"description":"审查需求和设计输出",
		"claude_agent_name":"review-agent",
		"skills_json":"[\"review\"]",
		"category":"business_processing",
		"prompt":"你是评审助手",
		"enabled":true
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body=%s)", rec.Code, rec.Body.String())
	}
	var got model.Agent
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != "agent_review_agent" {
		t.Fatalf("id = %q, want agent_review_agent", got.ID)
	}
	if got.Key != "review-agent" || got.Name != "评审智能体" || got.Role != "reviewer" {
		t.Fatalf("created agent mismatch: %+v", got)
	}
	if got.Category != model.AgentCategoryBusinessProcessing || got.Prompt != "你是评审助手" {
		t.Fatalf("category/prompt mismatch: %+v", got)
	}
	if got.SortOrder != 7 {
		t.Fatalf("sort_order = %d, want 7", got.SortOrder)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	listRec := httptest.NewRecorder()
	r.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", listRec.Code)
	}
	var all []model.Agent
	if err := json.NewDecoder(listRec.Body).Decode(&all); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(all) != 7 {
		t.Fatalf("len = %d, want 7", len(all))
	}
	if all[6].Key != "review-agent" {
		t.Fatalf("last key = %q, want review-agent", all[6].Key)
	}
}

func TestCreateAgentCreateAliasRoute(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{"key":"audit-agent","name":"审计智能体","role":"auditor","category":"business_processing","prompt":"你是审计助手"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents/create", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestCreateAgentMissingRequiredField(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{"key":"review-agent","name":"评审智能体"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCreateAgentInvalidSkillsJSON(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{"key":"review-agent","name":"评审智能体","role":"reviewer","skills_json":"not-json"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCreateAgentDuplicateKey(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{"key":"tester","name":"重复测试","role":"tester","category":"business_processing","prompt":"dup"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

// TestCreateAgentRejectsSoftwareDevelopmentCategory asserts manual creation
// cannot claim the pipeline-owned software_development category.
func TestCreateAgentRejectsSoftwareDevelopmentCategory(t *testing.T) {
	_, r := newAgentTestServer(t)
	body := bytes.NewBufferString(`{"key":"fake-pipeline","name":"伪流水线","role":"code_generation","category":"software_development","prompt":"x"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
}

// TestCreateAgentRejectsBusinessAgentWithoutPrompt asserts a business agent
// must carry a non-empty prompt.
func TestCreateAgentRejectsBusinessAgentWithoutPrompt(t *testing.T) {
	_, r := newAgentTestServer(t)
	body := bytes.NewBufferString(`{"key":"no-prompt","name":"无提示词","role":"ops","category":"business_processing"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agents", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestUpdateAgentEnabled(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{"enabled":false}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/agents/agent_code_generator", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var got model.Agent
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Enabled {
		t.Fatalf("enabled = true, want false")
	}
	if got.Key != "code-generator" {
		t.Fatalf("key = %q, want code-generator", got.Key)
	}
}

func TestUpdateAgentUnknownFieldsTolerated(t *testing.T) {
	_, r := newAgentTestServer(t)

	// Extra unknown fields must not cause a decode failure.
	body := bytes.NewBufferString(`{"enabled":true,"note":"ignored","sort_order":99}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/agents/agent_deployer", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestUpdateAgentNotFound(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{"enabled":false}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/agents/nope", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestUpdateAgentBadBody(t *testing.T) {
	_, r := newAgentTestServer(t)

	body := bytes.NewBufferString(`{not json`)
	req := httptest.NewRequest(http.MethodPatch, "/api/agents/agent_deployer", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// ccAgentRunsResponse is the response shape of GET /api/agents/:id/runs.
type ccAgentRunsResponse struct {
	Available bool   `json:"available"`
	Runs      []any  `json:"runs"`
	Warning   string `json:"warning,omitempty"`
}

// newCCStatusServer builds an httptest server that mimics cc-status's
// /healthz, /api/v1/agents, and /api/v1/skills endpoints. The returned server
// is closed automatically via t.Cleanup.
func newCCStatusServer(t *testing.T, baseURL string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeRawBody(w, http.StatusOK, `{"ok":true,"version":"test"}`)
	})
	mux.HandleFunc("/api/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		writeRawBody(w, http.StatusOK, `[
			{"id":"sa_1","session_id":"s1","agent_id":"a1","agent_type":"code-generator","status":"running","started_at":"2026-06-18T10:00:00Z"},
			{"id":"sa_2","session_id":"s2","agent_id":"a2","agent_type":"tester","status":"running","started_at":"2026-06-18T10:01:00Z"}
		]`)
	})
	mux.HandleFunc("/api/v1/skills", func(w http.ResponseWriter, r *http.Request) {
		writeRawBody(w, http.StatusOK, `[]`)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func writeRawBody(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// TestAgentRunsCCStatusUp verifies that when cc-status is reachable, the runs
// endpoint returns available=true and the subagents filtered by the Factory
// agent's ClaudeAgentName.
func TestAgentRunsCCStatusUp(t *testing.T) {
	srv, r := newAgentTestServer(t)
	cc := newCCStatusServer(t, "")
	srv.cc = &ccstatus.Client{BaseURL: cc.URL}

	req := httptest.NewRequest(http.MethodGet, "/api/agents/agent_code_generator/runs", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var resp ccAgentRunsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.Available {
		t.Fatalf("available = false, want true (warning=%q)", resp.Warning)
	}
	if resp.Warning != "" {
		t.Fatalf("warning = %q, want empty", resp.Warning)
	}
	// Only the code-generator subagent should survive the filter.
	if len(resp.Runs) != 1 {
		t.Fatalf("runs = %d, want 1 (filtered to code-generator)", len(resp.Runs))
	}
	r0, _ := resp.Runs[0].(map[string]any)
	if r0["agent_type"] != "code-generator" {
		t.Fatalf("run[0].agent_type = %v, want code-generator", r0["agent_type"])
	}
}

// TestAgentRunsCCStatusDown verifies graceful degradation: a down cc-status
// yields available=false, an empty runs array, and a warning — never a 5xx.
func TestAgentRunsCCStatusDown(t *testing.T) {
	srv, r := newAgentTestServer(t)
	// Point at a non-listening address with a short timeout so it fails fast.
	srv.cc = &ccstatus.Client{
		BaseURL: "http://127.0.0.1:1",
		HTTP:    &http.Client{Timeout: 200 * time.Millisecond},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/agents/agent_code_generator/runs", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (must degrade, not fail)", rec.Code)
	}
	var resp ccAgentRunsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Available {
		t.Fatalf("available = true, want false")
	}
	if len(resp.Runs) != 0 {
		t.Fatalf("runs = %d, want 0", len(resp.Runs))
	}
	if resp.Warning != "cc-status unavailable" {
		t.Fatalf("warning = %q, want %q", resp.Warning, "cc-status unavailable")
	}
}

// TestAgentRunsUnknownAgent verifies the 404 path still works regardless of
// cc-status state.
func TestAgentRunsUnknownAgent(t *testing.T) {
	srv, r := newAgentTestServer(t)
	cc := newCCStatusServer(t, "")
	srv.cc = &ccstatus.Client{BaseURL: cc.URL}

	req := httptest.NewRequest(http.MethodGet, "/api/agents/nope/runs", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// TestAgentRunsNilClient verifies that a Server with cc == nil (e.g. a future
// caller that forgets to wire it) still degrades rather than panicking.
func TestAgentRunsNilClient(t *testing.T) {
	srv, r := newAgentTestServer(t)
	srv.cc = nil

	req := httptest.NewRequest(http.MethodGet, "/api/agents/agent_code_generator/runs", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp ccAgentRunsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Available {
		t.Fatalf("available = true, want false when cc is nil")
	}
}
