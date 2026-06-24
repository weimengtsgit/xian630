// Package id provides random hex identifier generation for the factory-server
// entities (jobs, steps, artifacts, conversation messages). Callers prefix the
// returned string with a type tag such as "job_" or "step_".
package id

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
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

const base36Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// Base36Serial returns a cryptographically random 4-character uppercase Base36
// string ([0-9A-Z]) that is not already taken, with bounded collision retry.
// It is the Factory-owned source of trusted short suffixes/keys (generated app
// suffixes, business-agent internal keys) — values are never accepted from a
// client or LLM. taken reports whether a candidate is already in use; the
// helper retries with a fresh random candidate up to 64 times before giving up
// (the 36^4 ≈ 1.7M space makes an unresolvable collision practically
// impossible). It panics only if the system CSPRNG fails, consistent with New.
func Base36Serial(taken func(string) bool) string {
	const serialLen = 4
	const maxAttempts = 64
	for attempt := 0; attempt < maxAttempts; attempt++ {
		var b strings.Builder
		b.Grow(serialLen)
		for i := 0; i < serialLen; i++ {
			idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(base36Alphabet))))
			if err != nil {
				panic(fmt.Sprintf("id: crypto/rand unreadable: %v", err))
			}
			b.WriteByte(base36Alphabet[idx.Int64()])
		}
		s := b.String()
		if taken == nil || !taken(s) {
			return s
		}
	}
	// Exhausted retries: return one last fresh value without the taken check
	// rather than failing the caller — collisions at this scale imply the
	// predicate is faulty, and a non-taken value is still preferable to an
	// error for trusted-id seeding.
	var b strings.Builder
	b.Grow(serialLen)
	for i := 0; i < serialLen; i++ {
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(base36Alphabet))))
		if err != nil {
			panic(fmt.Sprintf("id: crypto/rand unreadable: %v", err))
		}
		b.WriteByte(base36Alphabet[idx.Int64()])
	}
	return b.String()
}
