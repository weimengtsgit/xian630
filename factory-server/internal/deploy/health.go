package deploy

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// pollInterval is the delay between successive health-check probes.
const pollInterval = 200 * time.Millisecond

// perRequestTimeout caps each individual HTTP probe.
const perRequestTimeout = 2 * time.Second

// CheckHTTP polls url with GET until it returns status 200-399 or the timeout
// elapses (design §5.6: "10 秒内返回 200-399"). It honors ctx cancellation.
// On timeout/failure it returns an error whose message contains
// "health_check_failed".
func CheckHTTP(ctx context.Context, url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: perRequestTimeout}

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

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
		if time.Now().After(deadline) {
			return fmt.Errorf("%s: last status %d", model.ErrorHealthCheckFailed, resp.StatusCode)
		}
	}
}
