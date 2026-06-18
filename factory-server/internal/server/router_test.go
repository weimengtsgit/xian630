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
