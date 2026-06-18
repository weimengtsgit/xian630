package deploy

import (
	"errors"
	"testing"
)

func TestAllocatorSkipsUsedPorts(t *testing.T) {
	a := Allocator{Start: 18000, End: 18002}
	used := map[int]bool{18000: true}
	port, err := a.Choose(func(p int) bool { return used[p] })
	if err != nil {
		t.Fatalf("choose: %v", err)
	}
	if port == 18000 {
		t.Fatalf("allocated used port %d", port)
	}
}

func TestAllocatorReturnsErrorWhenAllUsed(t *testing.T) {
	a := Allocator{Start: 18000, End: 18002}
	port, err := a.Choose(func(p int) bool { return true })
	if err == nil {
		t.Fatalf("expected error when all ports used, got port %d", port)
	}
	if !isPortUnavailable(err) {
		t.Fatalf("expected port_unavailable error, got: %v", err)
	}
}

func TestAllocatorTriesAtMostTwenty(t *testing.T) {
	// Wide range: ports 18000..18050. First 20 used, port 21 (18020) free.
	// Because the cap is 20 candidates, Choose must NOT find port 21 and error.
	a := Allocator{Start: 18000, End: 18050}
	port, err := a.Choose(func(p int) bool { return p < 18020 })
	if err == nil {
		t.Fatalf("expected error (cap=20), got port %d", port)
	}
	if !isPortUnavailable(err) {
		t.Fatalf("expected port_unavailable error, got: %v", err)
	}
}

func TestAllocatorSmallRangeTriesAll(t *testing.T) {
	// Range < 20: must try the whole range and find the free one at the end.
	a := Allocator{Start: 18000, End: 18002}
	used := map[int]bool{18000: true, 18001: true}
	port, err := a.Choose(func(p int) bool { return used[p] })
	if err != nil {
		t.Fatalf("choose: %v", err)
	}
	if port != 18002 {
		t.Fatalf("expected 18002, got %d", port)
	}
}

func TestDefaultAllocator(t *testing.T) {
	a := DefaultAllocator()
	if a.Start != 18000 || a.End != 18999 {
		t.Fatalf("default allocator = %+v, want 18000-18999", a)
	}
}

// isPortUnavailable reports whether err carries the port_unavailable sentinel.
func isPortUnavailable(err error) bool {
	return errors.Is(err, ErrPortUnavailable)
}
