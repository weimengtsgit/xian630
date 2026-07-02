package store

import (
	"context"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// CreateEphemeralCredentialRef inserts one controlled-credential metadata row.
// The row carries ONLY the opaque handle + focus/label/scope/expiry metadata —
// NEVER the plaintext credential value (that lives in the server's in-memory
// registry). The ID is caller-assigned ("cred_<id>") so the dialogue handler
// controls the lifecycle identifier; created_at/expires_at are persisted as
// INTEGER unix milliseconds via the shared ms helper.
func (s *Store) CreateEphemeralCredentialRef(ctx context.Context, ref model.EphemeralCredentialRef) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO ephemeral_credential_refs(id, dialogue_id, focus_key, label, scope, handle, created_at, expires_at)
VALUES(?,?,?,?,?,?,?,?)`,
		ref.ID, ref.DialogueID, ref.FocusKey, ref.Label, ref.Scope, ref.Handle, ms(ref.CreatedAt), ms(ref.ExpiresAt))
	return err
}

// ListEphemeralCredentialRefs returns the credential-ref metadata rows for one
// dialogue + focus key, newest-created first. The handle-availability check
// (CredentialHandleAvailable) is the real filter that drops expired/invalid
// handles before they reach input.json; this query surfaces all rows for the
// dialogue+focus so the caller can apply that gate. now is accepted as a
// parameter (rather than read from the clock) so callers pass a single
// consistent cutoff; it is currently unused for filtering here because the
// availability gate is authoritative, but it documents the query's temporal
// intent and keeps the signature stable for a future server-side expiry filter.
func (s *Store) ListEphemeralCredentialRefs(ctx context.Context, dialogueID, focusKey string, now time.Time) ([]model.EphemeralCredentialRef, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, dialogue_id, focus_key, label, scope, handle, created_at, expires_at
FROM ephemeral_credential_refs
WHERE dialogue_id=? AND focus_key=?
ORDER BY created_at DESC`, dialogueID, focusKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.EphemeralCredentialRef{}
	for rows.Next() {
		var ref model.EphemeralCredentialRef
		var created, expires int64
		if err := rows.Scan(&ref.ID, &ref.DialogueID, &ref.FocusKey, &ref.Label, &ref.Scope, &ref.Handle, &created, &expires); err != nil {
			return nil, err
		}
		ref.CreatedAt = time.UnixMilli(created)
		ref.ExpiresAt = time.UnixMilli(expires)
		out = append(out, ref)
	}
	return out, rows.Err()
}
