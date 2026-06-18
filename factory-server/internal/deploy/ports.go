package deploy

import (
	"errors"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// ErrPortUnavailable is the sentinel error returned by Allocator.Choose when no
// free port can be allocated. Its message is the model error code
// "port_unavailable" so callers (Task 12) can map it directly.
//
// Detect with errors.Is(err, ErrPortUnavailable).
var ErrPortUnavailable = errors.New(string(model.ErrorPortUnavailable))

// maxCandidates caps the number of ports Allocator.Choose probes per call
// (design §5.6: "最多重试 20 个候选端口").
const maxCandidates = 20

// Allocator hands out ports from the inclusive range [Start, End].
type Allocator struct {
	Start int
	End   int
}

// DefaultAllocator returns an Allocator over the design default pool 18000-18999.
func DefaultAllocator() Allocator {
	return Allocator{Start: 18000, End: 18999}
}

// Choose picks the first free port in [Start, End], trying at most
// maxCandidates (20) candidates and calling isUsed to check occupancy.
// It returns the chosen port, or an error wrapping ErrPortUnavailable when no
// free port is found within the cap.
func (a Allocator) Choose(isUsed func(int) bool) (int, error) {
	if a.End < a.Start {
		return 0, ErrPortUnavailable
	}

	for i := 0; i < maxCandidates; i++ {
		port := a.Start + i
		if port > a.End {
			break // range exhausted before the cap
		}
		if !isUsed(port) {
			return port, nil
		}
	}

	return 0, ErrPortUnavailable
}
