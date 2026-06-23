package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

type BusinessAgentSnapshot struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Prompt      string `json:"prompt"`
}

func (s *Store) ReplaceClarificationBusinessAgents(ctx context.Context, sessionID string, agentIDs []string) error {
	seen := map[string]bool{}
	for _, id := range agentIDs {
		if id == "" || seen[id] {
			return fmt.Errorf("duplicate or empty agent id %q", id)
		}
		seen[id] = true
		a, err := s.GetAgent(ctx, id)
		if err != nil {
			return err
		}
		if a == nil {
			return fmt.Errorf("agent %s not found", id)
		}
		if a.Category != model.AgentCategoryBusiness {
			return fmt.Errorf("agent %s is not a business agent", id)
		}
		if !a.Enabled {
			return fmt.Errorf("agent %s is disabled", id)
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `DELETE FROM clarification_business_agents WHERE clarification_session_id = ?`, sessionID); err != nil {
		return err
	}
	now := ms(time.Now())
	for i, id := range agentIDs {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO clarification_business_agents(clarification_session_id, agent_id, priority, created_at)
VALUES(?,?,?,?)`, sessionID, id, i+1, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ListClarificationBusinessAgents(ctx context.Context, sessionID string) ([]model.Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT `+agentSelectColumns+`
FROM clarification_business_agents cba
JOIN agents a ON a.id = cba.agent_id
WHERE cba.clarification_session_id = ?
ORDER BY cba.priority ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.Agent{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) BusinessAgentSnapshotsJSON(ctx context.Context, sessionID string) (string, error) {
	agents, err := s.ListClarificationBusinessAgents(ctx, sessionID)
	if err != nil {
		return "", err
	}
	snapshots := make([]BusinessAgentSnapshot, 0, len(agents))
	for _, a := range agents {
		if a.Category != model.AgentCategoryBusiness || !a.Enabled {
			return "", fmt.Errorf("selected business agent %s is unavailable", a.ID)
		}
		snapshots = append(snapshots, BusinessAgentSnapshot{
			ID:          a.ID,
			Key:         a.Key,
			Name:        a.Name,
			Description: a.Description,
			Enabled:     a.Enabled,
			Prompt:      a.Prompt,
		})
	}
	raw, err := json.Marshal(snapshots)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
