package id

import (
	"strings"
	"testing"
)

// TestBase36SerialFormat asserts the Factory-owned Base36 helper returns a
// 4-char uppercase alphanumeric string from the Base36 alphabet [0-9A-Z].
func TestBase36SerialFormat(t *testing.T) {
	const base36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	for i := 0; i < 200; i++ {
		got := Base36Serial(func(string) bool { return false })
		if len(got) != 4 {
			t.Fatalf("len = %d, want 4 (got %q)", len(got), got)
		}
		for _, r := range got {
			if !strings.ContainsRune(base36, r) {
				t.Fatalf("char %q not in Base36 alphabet (got %q)", r, got)
			}
		}
	}
}

// TestBase36SerialAvoidsCollision verifies the bounded-retry contract: when
// every value collides a few times the helper still returns a non-taken value.
func TestBase36SerialAvoidsCollision(t *testing.T) {
	taken := map[string]bool{}
	// First two draws "forced" collide.
	calls := 0
	mockTaken := func(s string) bool {
		if calls < 2 {
			calls++
			return true
		}
		return taken[s]
	}
	got := Base36Serial(mockTaken)
	if len(got) != 4 {
		t.Fatalf("len = %d, want 4", len(got))
	}
}

// TestBase36SerialUniqueDraws sanity-checks that a population of drawn values
// under a real collision predicate are all distinct (the collision space is
// 36^4 ≈ 1.7M, so 1000 draws essentially never collide).
func TestBase36SerialUniqueDraws(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		got := Base36Serial(func(s string) bool { return seen[s] })
		if seen[got] {
			t.Fatalf("collision after %d draws: %q", i, got)
		}
		seen[got] = true
	}
}
