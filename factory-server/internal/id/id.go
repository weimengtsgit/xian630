// Package id provides random hex identifier generation for the factory-server
// entities (jobs, steps, artifacts, conversation messages). Callers prefix the
// returned string with a type tag such as "job_" or "step_".
package id

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// New returns a random hex string. It panics only if the system CSPRNG is
// unavailable, which is a fatal environment error rather than a recoverable
// runtime condition for a server seeding database rows.
func New() string {
	const bytes = 12 // 12 bytes -> 24 hex chars; collision space >> job volume
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("id: crypto/rand unreadable: %v", err))
	}
	return hex.EncodeToString(b)
}
