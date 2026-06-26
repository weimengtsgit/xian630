package deploy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthCheckAccepts2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := CheckHTTP(context.Background(), srv.URL, time.Second); err != nil {
		t.Fatalf("check: %v", err)
	}
}

func TestHealthCheckAccepts3xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()
	if err := CheckHTTP(context.Background(), srv.URL, time.Second); err != nil {
		t.Fatalf("check: %v", err)
	}
}

func TestHealthCheckFailsOnTimeout(t *testing.T) {
	// Port 1 is reserved/not listening on most systems → connection refused,
	// which should exhaust retries within the timeout window.
	err := CheckHTTP(context.Background(), "http://127.0.0.1:1", 600*time.Millisecond)
	if err == nil {
		t.Fatalf("expected error on unreachable host")
	}
	if !strings.Contains(err.Error(), "health_check_failed") {
		t.Fatalf("expected health_check_failed in error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "last error:") {
		t.Fatalf("expected timeout error to include last probe error, got: %v", err)
	}
}

func TestHealthCheckTimeoutEnvOverride(t *testing.T) {
	t.Setenv("FACTORY_HEALTH_TIMEOUT", "750ms")
	if got := HealthCheckTimeout(); got != 750*time.Millisecond {
		t.Fatalf("HealthCheckTimeout() = %v, want 750ms", got)
	}
}

func TestHealthCheckTimeoutDefault(t *testing.T) {
	t.Setenv("FACTORY_HEALTH_TIMEOUT", "")
	if got := HealthCheckTimeout(); got != defaultHealthCheckTimeout {
		t.Fatalf("HealthCheckTimeout() = %v, want %v", got, defaultHealthCheckTimeout)
	}
}

func TestHealthCheckTimeoutInvalidFallsBack(t *testing.T) {
	t.Setenv("FACTORY_HEALTH_TIMEOUT", "not-a-duration")
	if got := HealthCheckTimeout(); got != defaultHealthCheckTimeout {
		t.Fatalf("HealthCheckTimeout() = %v, want %v", got, defaultHealthCheckTimeout)
	}
}
