package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRouterMatchesMethodAndParams(t *testing.T) {
	r := &Router{}
	r.Handle("GET", "/api/apps/:id", func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(Param(req, "id")))
	})

	req := httptest.NewRequest("GET", "/api/apps/app_1", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.String() != "app_1" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestRouterWildcardCapturesRemainingSegments(t *testing.T) {
	r := &Router{}
	r.Handle("GET", "/api/jobs/:id/steps/:stepID/prototype/static/*path", func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(Param(req, "id") + "|" + Param(req, "stepID") + "|" + Param(req, "path")))
	})

	tests := []struct {
		url      string
		wantCode int
		wantBody string
	}{
		{"/api/jobs/j1/steps/s1/prototype/static/styles.css", http.StatusOK, "j1|s1|styles.css"},
		{"/api/jobs/j1/steps/s1/prototype/static/css/style.css", http.StatusOK, "j1|s1|css/style.css"},
		{"/api/jobs/j1/steps/s1/prototype/static/a/b/c/d.js", http.StatusOK, "j1|s1|a/b/c/d.js"},
		// Wildcard requires at least one remaining segment.
		{"/api/jobs/j1/steps/s1/prototype/static/", http.StatusNotFound, ""},
		// Non-matching prefix should 404.
		{"/api/jobs/j1/steps/s1/prototype/other/file.css", http.StatusNotFound, ""},
	}

	for _, tt := range tests {
		req := httptest.NewRequest("GET", tt.url, nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != tt.wantCode {
			t.Errorf("GET %s: status = %d, want %d", tt.url, rec.Code, tt.wantCode)
		}
		if tt.wantCode == http.StatusOK && rec.Body.String() != tt.wantBody {
			t.Errorf("GET %s: body = %q, want %q", tt.url, rec.Body.String(), tt.wantBody)
		}
	}
}
