package deploy

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// pollInterval is the delay between successive health-check probes.
const pollInterval = 200 * time.Millisecond

// perRequestTimeout caps each individual HTTP probe.
const perRequestTimeout = 2 * time.Second

// defaultHealthCheckTimeout is the post-start readiness probe timeout. The
// original design §5.6 specified 10s, but real-world local Podman (especially on
// macOS) needs more time for networking/port-forwarding to settle; 30s keeps
// failures fast enough while covering the observed flakiness.
const defaultHealthCheckTimeout = 30 * time.Second

// HealthCheckTimeout returns the readiness-probe timeout. Override with
// FACTORY_HEALTH_TIMEOUT (e.g. "10s", "1m") for environments that need a
// different value.
func HealthCheckTimeout() time.Duration {
	if v := os.Getenv("FACTORY_HEALTH_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return defaultHealthCheckTimeout
}

// CheckHTTP polls url with GET until it returns status 200-399 or the timeout
// elapses. It honors ctx cancellation. On timeout/failure it returns an error
// whose message contains "health_check_failed".
// isLocalhost reports whether host is a loopback or link-local address that
// should never go through a proxy.
func isLocalhost(host string) bool {
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback() || ip.IsLinkLocalUnicast()
	}
	return false
}

// noProxyTransport is an http.RoundTripper that bypasses any configured proxy
// for requests to localhost — container health checks are always local and must
// never be routed through a SOCKS/HTTP proxy.
var noProxyTransport = &http.Transport{
	Proxy: func(r *http.Request) (*url.URL, error) {
		if isLocalhost(r.URL.Hostname()) {
			return nil, nil // direct, no proxy
		}
		return http.ProxyFromEnvironment(r)
	},
	DialContext: (&net.Dialer{Timeout: perRequestTimeout}).DialContext,
}

func CheckHTTP(ctx context.Context, url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: perRequestTimeout, Transport: noProxyTransport}

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	var lastErr error
	var lastStatus int

	// Probe immediately, then on each tick.
	firstProbe := true
	for {
		if firstProbe {
			firstProbe = false
		} else {
			select {
			case <-ctx.Done():
				return fmt.Errorf("%s: %w", model.ErrorHealthCheckFailed, ctx.Err())
			case <-ticker.C:
			}
		}

		if time.Now().After(deadline) {
			if lastErr != nil {
				return fmt.Errorf("%s: timeout after %s (last error: %v)", model.ErrorHealthCheckFailed, timeout, lastErr)
			}
			if lastStatus != 0 {
				return fmt.Errorf("%s: timeout after %s (last status: %d)", model.ErrorHealthCheckFailed, timeout, lastStatus)
			}
			return fmt.Errorf("%s: timeout after %s", model.ErrorHealthCheckFailed, timeout)
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", model.ErrorHealthCheckFailed, err)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return fmt.Errorf("%s: bad url %q: %w", model.ErrorHealthCheckFailed, url, err)
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			lastStatus = 0
			// Transient/conn-refused: keep polling until deadline.
			if time.Now().After(deadline) {
				return fmt.Errorf("%s: %w", model.ErrorHealthCheckFailed, err)
			}
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode <= 399 {
			return nil
		}
		lastErr = nil
		lastStatus = resp.StatusCode
		if time.Now().After(deadline) {
			return fmt.Errorf("%s: last status %d", model.ErrorHealthCheckFailed, resp.StatusCode)
		}
	}
}
