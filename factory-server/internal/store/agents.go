package store

import (
	"context"
	"database/sql"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

const agentSelectColumns = `id, key, name, role, description, claude_agent_name, skills_json, enabled, sort_order, category, prompt, editable`

// UpsertAgent inserts an agent, or on id conflict refreshes its immutable and
// descriptive fields (key, name, role, description, claude_agent_name,
// skills_json, sort_order, category, prompt, editable) from the supplied value.
// The enabled flag is write-on-insert only: on conflict the existing DB value is
// preserved so that a runtime enable/disable via SetAgentEnabled survives the
// next startup upsert of the default registry (see design §7.2).
func (s *Store) UpsertAgent(ctx context.Context, a model.Agent) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agents(id, key, name, role, description, claude_agent_name, skills_json, enabled, sort_order, category, prompt, editable)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  key               = excluded.key,
  name              = excluded.name,
  role              = excluded.role,
  description       = excluded.description,
  claude_agent_name = excluded.claude_agent_name,
  skills_json       = excluded.skills_json,
  sort_order        = excluded.sort_order,
  category          = excluded.category,
  prompt            = excluded.prompt,
  editable          = excluded.editable`,
		a.ID, a.Key, a.Name, a.Role, a.Description,
		a.ClaudeAgentName, a.SkillsJSON, boolToInt(a.Enabled), a.SortOrder,
		string(a.Category), a.Prompt, boolToInt(a.Editable))
	return err
}

// CreateAgent inserts a new user-defined agent. It intentionally does not
// upsert: duplicate ids or keys should surface to the caller.
func (s *Store) CreateAgent(ctx context.Context, a model.Agent) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO agents(id, key, name, role, description, claude_agent_name, skills_json, enabled, sort_order, category, prompt, editable)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID, a.Key, a.Name, a.Role, a.Description,
		a.ClaudeAgentName, a.SkillsJSON, boolToInt(a.Enabled), a.SortOrder,
		string(a.Category), a.Prompt, boolToInt(a.Editable))
	return err
}

// ListAgents returns every known agent ordered by sort_order ascending.
func (s *Store) ListAgents(ctx context.Context) ([]model.Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT `+agentSelectColumns+`
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

// ListAgentsByCategory returns the agents in the given category ordered by
// sort_order ascending. Used by the portal to fetch only the business agents
// (or only the software agents) for category-scoped views.
func (s *Store) ListAgentsByCategory(ctx context.Context, category model.AgentCategory) ([]model.Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT `+agentSelectColumns+`
FROM agents
WHERE category = ?
ORDER BY sort_order ASC`, string(category))
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
SELECT `+agentSelectColumns+`
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

// UpdateBusinessAgent writes the mutable fields of an editable business agent:
// name, role, description, claude_agent_name, skills_json, enabled, prompt. The
// WHERE clause pins the row to category='business' AND editable=1, so a software
// agent (or a non-editable business agent) is a no-op even if the caller supplies
// its id — the handler surfaces this as 403 by pre-checking with GetAgent. The
// agents table has no updated_at column, so none is touched.
func (s *Store) UpdateBusinessAgent(ctx context.Context, a model.Agent) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE agents
SET name = ?, role = ?, description = ?, claude_agent_name = ?, skills_json = ?, enabled = ?, prompt = ?
WHERE id = ? AND category = 'business' AND editable = 1`,
		a.Name, a.Role, a.Description, a.ClaudeAgentName, a.SkillsJSON, boolToInt(a.Enabled), a.Prompt, a.ID)
	return err
}

// scanAgent reads an agent row into a *model.Agent, mapping INTEGER boolean
// columns back to bool. It works for both sql.Row and sql.Rows. The raw scan
// error is returned unwrapped so callers can detect sql.ErrNoRows.
func scanAgent(sc scanner) (*model.Agent, error) {
	var a model.Agent
	var enabled, editable int
	var category string
	if err := sc.Scan(&a.ID, &a.Key, &a.Name, &a.Role, &a.Description,
		&a.ClaudeAgentName, &a.SkillsJSON, &enabled, &a.SortOrder,
		&category, &a.Prompt, &editable); err != nil {
		return nil, err
	}
	a.Enabled = enabled != 0
	a.Editable = editable != 0
	a.Category = model.AgentCategory(category)
	if a.Category == "" {
		a.Category = model.AgentCategoryBusiness
	}
	return &a, nil
}
