package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// UpsertAgent inserts an agent, or on id conflict refreshes its immutable and
// descriptive fields (key, name, role, description, claude_agent_name,
// skills_json, category, prompt, sort_order) from the supplied value. The
// enabled flag AND created_at are write-on-insert only: on conflict the
// existing DB values are preserved so a runtime enable/disable survives the
// next startup upsert of the default registry (see design §7.2) and the
// agent's original generation time is never overwritten by a seed refresh.
func (s *Store) UpsertAgent(ctx context.Context, a model.Agent) error {
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agents(id, key, name, role, description, claude_agent_name, skills_json, category, prompt, enabled, sort_order, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  key               = excluded.key,
  name              = excluded.name,
  role              = excluded.role,
  description       = excluded.description,
  claude_agent_name = excluded.claude_agent_name,
  skills_json       = excluded.skills_json,
  category          = excluded.category,
  prompt            = excluded.prompt,
  sort_order        = excluded.sort_order`,
		a.ID, a.Key, a.Name, a.Role, a.Description,
		a.ClaudeAgentName, a.SkillsJSON, string(a.Category), a.Prompt,
		boolToInt(a.Enabled), a.SortOrder, ms(a.CreatedAt))
	return err
}

// CreateAgent inserts a new user-defined agent. It intentionally does not
// upsert: duplicate ids or keys should surface to the caller.
func (s *Store) CreateAgent(ctx context.Context, a model.Agent) error {
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agents(id, key, name, role, description, claude_agent_name, skills_json, category, prompt, enabled, sort_order, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.Key, a.Name, a.Role, a.Description,
		a.ClaudeAgentName, a.SkillsJSON, string(a.Category), a.Prompt,
		boolToInt(a.Enabled), a.SortOrder, ms(a.CreatedAt))
	return err
}

// ListAgents returns every known agent ordered by sort_order ascending.
func (s *Store) ListAgents(ctx context.Context) ([]model.Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, key, name, role, description, claude_agent_name, skills_json, category, prompt, enabled, sort_order, created_at
FROM agents
ORDER BY sort_order ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]model.Agent, 0)
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// GetAgent returns the agent with the given id. It returns (nil, nil) when no
// such agent exists — a miss is not an error — mirroring GetApplication.
func (s *Store) GetAgent(ctx context.Context, id string) (*model.Agent, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, key, name, role, description, claude_agent_name, skills_json, category, prompt, enabled, sort_order, created_at
FROM agents
WHERE id = ?`, id)
	a, err := scanAgent(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}

// SetAgentEnabled toggles the enabled flag on the agent with the given id. It
// is not an error if the id does not match any row (the caller checks existence
// via GetAgent and surfaces a 404).
func (s *Store) SetAgentEnabled(ctx context.Context, id string, enabled bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agents SET enabled = ? WHERE id = ?`,
		boolToInt(enabled), id)
	return err
}

// DeleteAgent deletes an agent row by id. A missing row is not an error (the
// caller checks existence via GetAgent and surfaces a 404), mirroring
// SetAgentEnabled and DeleteApplication.
func (s *Store) DeleteAgent(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM agents WHERE id = ?`, id)
	return err
}

// scanAgent reads an agent row into a *model.Agent, mapping the INTEGER enabled
// column back to bool. It works for both sql.Row and sql.Rows. The raw scan
// error is returned unwrapped so callers can detect sql.ErrNoRows.
func scanAgent(sc scanner) (*model.Agent, error) {
	var a model.Agent
	var enabled int
	var category string
	var createdMs int64
	if err := sc.Scan(&a.ID, &a.Key, &a.Name, &a.Role, &a.Description,
		&a.ClaudeAgentName, &a.SkillsJSON, &category, &a.Prompt, &enabled, &a.SortOrder, &createdMs); err != nil {
		return nil, err
	}
	a.Enabled = enabled != 0
	a.Category = model.AgentCategory(category)
	a.CreatedAt = time.UnixMilli(createdMs)
	return &a, nil
}
