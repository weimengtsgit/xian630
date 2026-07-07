package server

import (
	"time"

	idpkg "github.com/weimengtsgit/xian630/factory-server/internal/id"
)

// runtimeCredentialSecret is the in-memory-only record of a controlled
// credential value. It is NEVER persisted to the database, written to
// input.json/output.json, project docs, attachments, dialogue messages, SSE
// payloads, or logs. Only the opaque Handle is persisted (in
// ephemeral_credential_refs.handle); the Value lives solely behind that handle
// in the Server's credentialSecrets registry.
type runtimeCredentialSecret struct {
	DialogueID string
	Scope      string
	Value      string
	ExpiresAt  time.Time
}

// credentialSecretTTL is the lifetime of a runtime secret. After it elapses the
// handle is rejected by CredentialHandleAvailable and removed from the registry
// so the value can no longer be resolved. Mirrors the persisted ref's 30m
// expiry in dialogue_handlers.go.
const credentialSecretTTL = 30 * time.Minute

// storeRuntimeSecret stores a controlled credential value in the in-memory
// registry under a freshly-generated opaque handle ("secret_<id>") and returns
// the handle. The handle is the ONLY identifier persisted or surfaced; the
// plaintext value remains reachable solely via this registry, and only through
// a server-side verifier that calls CredentialHandleAvailable.
//
// The value MUST NOT be embedded in the handle (the handle is random id only).
func (s *Server) storeRuntimeSecret(dialogueID, scope, value string) string {
	handle := "secret_" + idpkg.New()
	s.credentialSecrets.Store(handle, runtimeCredentialSecret{
		DialogueID: dialogueID,
		Scope:      scope,
		Value:      value,
		ExpiresAt:  time.Now().Add(credentialSecretTTL),
	})
	return handle
}

// CredentialHandleAvailable reports whether handle identifies a live (present
// and unexpired) runtime secret. It is the single availability gate the
// executor's data_integration step consults before injecting a credential ref
// into input.json's controlledCredentialRefs. On a missing OR expired handle it
// returns false and — for an expired-but-present entry — deletes it so the
// value is reclaimed and cannot be reused. It NEVER returns the value.
func (s *Server) CredentialHandleAvailable(handle string) bool {
	if handle == "" {
		return false
	}
	v, ok := s.credentialSecrets.Load(handle)
	if !ok {
		return false
	}
	secret, ok := v.(runtimeCredentialSecret)
	if !ok || time.Now().After(secret.ExpiresAt) {
		// Reclaim an expired or malformed entry so the value is dropped promptly.
		s.credentialSecrets.Delete(handle)
		return false
	}
	return true
}
