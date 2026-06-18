package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/weimengtsgit/xian630/cc-status/internal/model"
)

// NewID returns a short random hex id (used when a natural key is absent).
func NewID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ----------------------------- subagents ------------------------------------

// StartSubagent upserts a subagent as running. On conflict it only refreshes
// last_seen_at and fills agent_type/session, preserving the original
// status/started_at.
func (s *Store) StartSubagent(sa model.Subagent) error {
	if sa.ID == "" {
		sa.ID = NewID()
	}
	_, err := s.db.Exec(`
INSERT INTO subagents(id, session_id, agent_id, agent_type, description, status, started_at, ended_at,
  duration_ms, transcript_path, last_assistant_message, model, total_tokens, tool_use_count, parent_tool_use_id, last_seen_at)
VALUES(?,?,?,?,?, 'running', ?, NULL, NULL, ?, '', ?, 0, 0, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  session_id   = excluded.session_id,
  agent_type   = COALESCE(NULLIF(excluded.agent_type,''), subagents.agent_type),
  last_seen_at = excluded.last_seen_at`,
		sa.ID, sa.SessionID, sa.AgentID, sa.AgentType, sa.Description,
		ms(sa.StartedAt), sa.TranscriptPath, sa.Model, sa.ParentToolUseID, ms(sa.LastSeenAt))
	return err
}

// StopSubagent marks a subagent completed.
func (s *Store) StopSubagent(id string, endedAt time.Time, lastMsg, transcript string) error {
	_, err := s.db.Exec(`
UPDATE subagents SET status='completed', ended_at=?, last_assistant_message=COALESCE(NULLIF(?, ''), last_assistant_message),
  transcript_path=COALESCE(NULLIF(?, ''), transcript_path), last_seen_at=? WHERE id=?`,
		ms(endedAt), lastMsg, transcript, ms(endedAt), id)
	return err
}

// EnrichSubagent fills detail fields from PostToolUse(Agent) tool_response.
// Empty values are ignored so they do not clobber existing data.
func (s *Store) EnrichSubagent(id string, m string, tokens, toolUse, durationMs int64, description string) error {
	_, err := s.db.Exec(`
UPDATE subagents SET
  model        = COALESCE(NULLIF(?, ''), model),
  total_tokens = CASE WHEN ?>0 THEN ? ELSE total_tokens END,
  tool_use_count = CASE WHEN ?>0 THEN ? ELSE tool_use_count END,
  duration_ms  = CASE WHEN ?>0 THEN ? ELSE duration_ms END,
  description  = COALESCE(NULLIF(?, ''), description)
WHERE id=?`,
		m, tokens, tokens, toolUse, toolUse, durationMs, durationMs, description, id)
	return err
}

// GetSubagent returns one subagent by id.
func (s *Store) GetSubagent(id string) (*model.Subagent, error) {
	row := s.db.QueryRow(subagentCols()+` FROM subagents WHERE id=?`, id)
	sa, err := scanSubagent(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return sa, err
}

// ListSubagents returns subagents optionally filtered by session and status.
func (s *Store) ListSubagents(sessionID, status string, limit, offset int) ([]model.Subagent, error) {
	q, args := subagentQuery(sessionID, status)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Subagent, 0)
	for rows.Next() {
		sa, err := scanSubagent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sa)
	}
	return out, rows.Err()
}

func subagentCols() string {
	return `SELECT id, session_id, agent_id, agent_type, description, status, started_at, ended_at,
  duration_ms, transcript_path, last_assistant_message, model, total_tokens, tool_use_count, parent_tool_use_id, last_seen_at`
}

func subagentQuery(sessionID, status string) (string, []any) {
	q := subagentCols() + ` FROM subagents`
	var where []string
	var args []any
	if sessionID != "" {
		where = append(where, "session_id=?")
		args = append(args, sessionID)
	}
	if status != "" {
		where = append(where, "status=?")
		args = append(args, status)
	}
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
	args = append(args, defaultLimit(500), 0)
	return q, args
}

func scanSubagent(sc scanner) (*model.Subagent, error) {
	var sa model.Subagent
	var started, last int64
	var ended sql.NullInt64
	var duration sql.NullInt64
	var status string
	if err := sc.Scan(&sa.ID, &sa.SessionID, &sa.AgentID, &sa.AgentType, &sa.Description, &status,
		&started, &ended, &duration, &sa.TranscriptPath, &sa.LastAssistantMessage, &sa.Model,
		&sa.TotalTokens, &sa.ToolUseCount, &sa.ParentToolUseID, &last); err != nil {
		return nil, err
	}
	sa.Status = model.Status(status)
	sa.StartedAt = time.UnixMilli(started)
	sa.LastSeenAt = time.UnixMilli(last)
	sa.EndedAt = ptrFromMs(ended)
	if duration.Valid {
		sa.DurationMs = duration.Int64
	}
	return &sa, nil
}

// ------------------------------- skills -------------------------------------

// StartSkill inserts a skill invocation (idempotent on id).
func (s *Store) StartSkill(sk model.Skill) error {
	if sk.ID == "" {
		sk.ID = NewID()
	}
	_, err := s.db.Exec(`
INSERT INTO skills(id, session_id, agent_id, name, source, status, started_at, ended_at, duration_ms, tool_use_id, last_seen_at)
VALUES(?,?,?,?,?, 'running', ?, NULL, 0, ?, ?)
ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
		sk.ID, sk.SessionID, sk.AgentID, sk.Name, sk.Source, ms(sk.StartedAt), sk.ToolUseID, ms(sk.LastSeenAt))
	return err
}

// StopSkill marks a skill completed.
func (s *Store) StopSkill(id string, endedAt time.Time, durationMs int64) error {
	_, err := s.db.Exec(`UPDATE skills SET status='completed', ended_at=?, duration_ms=?, last_seen_at=? WHERE id=?`,
		ms(endedAt), durationMs, ms(endedAt), id)
	return err
}

// CloseOpenSlashSkills marks all still-open slash skills for a session
// completed (slash skills have no precise end event; the turn boundary is the
// approximation).
func (s *Store) CloseOpenSlashSkills(sessionID string, ts time.Time) error {
	_, err := s.db.Exec(`UPDATE skills SET status='completed', ended_at=?, last_seen_at=? WHERE session_id=? AND source='slash' AND ended_at IS NULL`,
		ms(ts), ms(ts), sessionID)
	return err
}

// GetSkill returns one skill by id.
func (s *Store) GetSkill(id string) (*model.Skill, error) {
	row := s.db.QueryRow(`SELECT id, session_id, agent_id, name, source, status, started_at, ended_at, duration_ms, tool_use_id, last_seen_at FROM skills WHERE id=?`, id)
	sk, err := scanSkill(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return sk, err
}

// ListSkills returns skills optionally filtered by session and status.
func (s *Store) ListSkills(sessionID, status string, limit, offset int) ([]model.Skill, error) {
	q := `SELECT id, session_id, agent_id, name, source, status, started_at, ended_at, duration_ms, tool_use_id, last_seen_at FROM skills`
	var where []string
	var args []any
	if sessionID != "" {
		where = append(where, "session_id=?")
		args = append(args, sessionID)
	}
	if status != "" {
		where = append(where, "status=?")
		args = append(args, status)
	}
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
	args = append(args, defaultLimit(limit), offset)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Skill, 0)
	for rows.Next() {
		sk, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sk)
	}
	return out, rows.Err()
}

func scanSkill(sc scanner) (*model.Skill, error) {
	var sk model.Skill
	var started, last int64
	var ended sql.NullInt64
	var status string
	if err := sc.Scan(&sk.ID, &sk.SessionID, &sk.AgentID, &sk.Name, &sk.Source, &status, &started, &ended, &sk.DurationMs, &sk.ToolUseID, &last); err != nil {
		return nil, err
	}
	sk.Status = model.Status(status)
	sk.StartedAt = time.UnixMilli(started)
	sk.LastSeenAt = time.UnixMilli(last)
	sk.EndedAt = ptrFromMs(ended)
	return &sk, nil
}

func defaultLimit(n int) int {
	if n <= 0 || n > 1000 {
		return 500
	}
	return n
}

// ListSkillsByAgent returns skills invoked inside a given subagent (agent_id).
func (s *Store) ListSkillsByAgent(agentID string) ([]model.Skill, error) {
	q := `SELECT id, session_id, agent_id, name, source, status, started_at, ended_at, duration_ms, tool_use_id, last_seen_at FROM skills WHERE agent_id=? ORDER BY started_at DESC LIMIT 500`
	rows, err := s.db.Query(q, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Skill, 0)
	for rows.Next() {
		sk, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sk)
	}
	return out, rows.Err()
}

// --------------------------- background tasks -------------------------------

// SyncBackgroundTasks reconciles the stored set for a session against a fresh
// snapshot from a Stop/SubagentStop hook. Tasks absent from the snapshot are
// marked completed.
func (s *Store) SyncBackgroundTasks(sessionID string, snap []model.BackgroundTask, ts time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	seen := make(map[string]struct{}, len(snap))
	for _, bt := range snap {
		if bt.TaskID == "" {
			continue
		}
		id := fmt.Sprintf("%s:%s", sessionID, bt.TaskID)
		seen[id] = struct{}{}
		if _, err := tx.Exec(`
INSERT INTO background_tasks(id, session_id, task_id, type, status, description, command, agent_type, tool, name, first_seen_at, last_seen_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  type=COALESCE(NULLIF(excluded.type,''), background_tasks.type),
  status=excluded.status,
  description=COALESCE(NULLIF(excluded.description,''), background_tasks.description),
  command=COALESCE(NULLIF(excluded.command,''), background_tasks.command),
  agent_type=COALESCE(NULLIF(excluded.agent_type,''), background_tasks.agent_type),
  tool=COALESCE(NULLIF(excluded.tool,''), background_tasks.tool),
  name=COALESCE(NULLIF(excluded.name,''), background_tasks.name),
  last_seen_at=excluded.last_seen_at`,
			id, sessionID, bt.TaskID, bt.Type, bt.Status, bt.Description, bt.Command, bt.AgentType, bt.Tool, bt.Name, ms(ts), ms(ts)); err != nil {
			return err
		}
	}

	// Mark previously-seen tasks that dropped out of the snapshot as completed.
	if _, err := tx.Exec(`UPDATE background_tasks SET status='completed', last_seen_at=? WHERE session_id=? AND status NOT IN ('completed','failed') AND id NOT IN (SELECT value FROM json_each(?))`,
		ms(ts), sessionID, seenJSON(seen)); err != nil {
		return err
	}
	return tx.Commit()
}

// seenJSON builds a JSON array of the seen ids for the json_each anti-join.
func seenJSON(seen map[string]struct{}) string {
	if len(seen) == 0 {
		return "[]"
	}
	var b strings.Builder
	b.WriteByte('[')
	first := true
	for k := range seen {
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.WriteString(sqlQuote(k))
	}
	b.WriteByte(']')
	return b.String()
}

func sqlQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `'`, `''`)
	return "'" + r.Replace(s) + "'"
}

// ListBackgroundTasks returns background tasks optionally filtered by session.
func (s *Store) ListBackgroundTasks(sessionID, status string, limit, offset int) ([]model.BackgroundTask, error) {
	q := `SELECT id, session_id, task_id, type, status, description, command, agent_type, tool, name, first_seen_at, last_seen_at FROM background_tasks`
	var where []string
	var args []any
	if sessionID != "" {
		where = append(where, "session_id=?")
		args = append(args, sessionID)
	}
	if status != "" {
		where = append(where, "status=?")
		args = append(args, status)
	}
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY last_seen_at DESC LIMIT ? OFFSET ?"
	args = append(args, defaultLimit(limit), offset)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.BackgroundTask, 0)
	for rows.Next() {
		var bt model.BackgroundTask
		var first, last int64
		if err := rows.Scan(&bt.ID, &bt.SessionID, &bt.TaskID, &bt.Type, &bt.Status, &bt.Description, &bt.Command, &bt.AgentType, &bt.Tool, &bt.Name, &first, &last); err != nil {
			return nil, err
		}
		bt.FirstSeenAt = time.UnixMilli(first)
		bt.LastSeenAt = time.UnixMilli(last)
		out = append(out, bt)
	}
	return out, rows.Err()
}

// GetBackgroundTask returns one background task by its row id.
func (s *Store) GetBackgroundTask(id string) (*model.BackgroundTask, error) {
	row := s.db.QueryRow(`SELECT id, session_id, task_id, type, status, description, command, agent_type, tool, name, first_seen_at, last_seen_at FROM background_tasks WHERE id=?`, id)
	var bt model.BackgroundTask
	var first, last int64
	err := row.Scan(&bt.ID, &bt.SessionID, &bt.TaskID, &bt.Type, &bt.Status, &bt.Description, &bt.Command, &bt.AgentType, &bt.Tool, &bt.Name, &first, &last)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	bt.FirstSeenAt = time.UnixMilli(first)
	bt.LastSeenAt = time.UnixMilli(last)
	return &bt, nil
}

// ------------------------------- events -------------------------------------

// AppendEvent stores a raw hook payload and returns its sequence number.
func (s *Store) AppendEvent(sessionID, hookEvent string, payload []byte) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO events(ts, session_id, hook_event_name, payload) VALUES(?,?,?,?)`,
		ms(time.Now()), nullStr(sessionID), hookEvent, string(payload))
	if err != nil {
		return 0, err
	}
	seq, _ := res.LastInsertId()
	return seq, nil
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ListEventsAfter returns events with seq > after, in order (for SSE catch-up).
func (s *Store) ListEventsAfter(after int64, limit int) ([]model.EventRow, error) {
	rows, err := s.db.Query(`SELECT seq, ts, session_id, hook_event_name FROM events WHERE seq > ? ORDER BY seq LIMIT ?`, after, defaultLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.EventRow
	for rows.Next() {
		var er model.EventRow
		var ts int64
		var sid sql.NullString
		if err := rows.Scan(&er.Seq, &ts, &sid, &er.HookEventName); err != nil {
			return nil, err
		}
		er.Ts = time.UnixMilli(ts)
		er.SessionID = sid.String
		out = append(out, er)
	}
	return out, rows.Err()
}

// --------------------------- running snapshot -------------------------------

// RunningSnapshot returns everything currently considered running/stale.
func (s *Store) RunningSnapshot() (model.RunningSnapshot, error) {
	var snap model.RunningSnapshot
	var err error
	if snap.Sessions, err = s.ListSessions("running", 500, 0); err != nil {
		return snap, err
	}
	if snap.Subagents, err = s.listSubagentsByStatus([]string{"running", "stale"}); err != nil {
		return snap, err
	}
	if snap.Skills, err = s.listSkillsByStatus([]string{"running", "stale"}); err != nil {
		return snap, err
	}
	if snap.BackgroundTasks, err = s.listBTActive(); err != nil {
		return snap, err
	}
	return snap, nil
}

func (s *Store) listSubagentsByStatus(statuses []string) ([]model.Subagent, error) {
	placeholders := strings.Repeat("?,", len(statuses))
	placeholders = placeholders[:len(placeholders)-1]
	q := subagentCols() + ` FROM subagents WHERE status IN (` + placeholders + `) ORDER BY started_at DESC`
	args := make([]any, len(statuses))
	for i, st := range statuses {
		args[i] = st
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Subagent, 0)
	for rows.Next() {
		sa, err := scanSubagent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sa)
	}
	return out, rows.Err()
}

func (s *Store) listSkillsByStatus(statuses []string) ([]model.Skill, error) {
	placeholders := strings.Repeat("?,", len(statuses))
	placeholders = placeholders[:len(placeholders)-1]
	q := `SELECT id, session_id, agent_id, name, source, status, started_at, ended_at, duration_ms, tool_use_id, last_seen_at FROM skills WHERE status IN (` + placeholders + `) ORDER BY started_at DESC`
	args := make([]any, len(statuses))
	for i, st := range statuses {
		args[i] = st
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Skill, 0)
	for rows.Next() {
		sk, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sk)
	}
	return out, rows.Err()
}

func (s *Store) listBTActive() ([]model.BackgroundTask, error) {
	rows, err := s.db.Query(`SELECT id, session_id, task_id, type, status, description, command, agent_type, tool, name, first_seen_at, last_seen_at FROM background_tasks WHERE status NOT IN ('completed','failed') ORDER BY last_seen_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.BackgroundTask, 0)
	for rows.Next() {
		var bt model.BackgroundTask
		var first, last int64
		if err := rows.Scan(&bt.ID, &bt.SessionID, &bt.TaskID, &bt.Type, &bt.Status, &bt.Description, &bt.Command, &bt.AgentType, &bt.Tool, &bt.Name, &first, &last); err != nil {
			return nil, err
		}
		bt.FirstSeenAt = time.UnixMilli(first)
		bt.LastSeenAt = time.UnixMilli(last)
		out = append(out, bt)
	}
	return out, rows.Err()
}

// ----------------------------- maintenance ----------------------------------

// ReapGhosts marks running entities not updated since cutoff as stale. Returns
// the number of rows reaped.
func (s *Store) ReapGhosts(cutoff time.Time) (int, error) {
	var total int64
	for _, table := range []string{"sessions", "subagents", "skills"} {
		res, err := s.db.Exec(fmt.Sprintf(`UPDATE %s SET status='stale' WHERE status='running' AND last_seen_at < ?`, table), ms(cutoff))
		if err != nil {
			return int(total), err
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return int(total), nil
}

// PruneBefore deletes completed/stale entities whose end (or last-seen) time is
// older than cutoff. Returns the number of rows deleted.
func (s *Store) PruneBefore(cutoff time.Time) (int, error) {
	var total int64
	for _, table := range []string{"sessions", "subagents", "skills", "background_tasks"} {
		var res sql.Result
		var err error
		if table == "background_tasks" {
			res, err = s.db.Exec(fmt.Sprintf(`DELETE FROM %s WHERE status IN ('completed','failed') AND last_seen_at < ?`, table), ms(cutoff))
		} else {
			res, err = s.db.Exec(fmt.Sprintf(`DELETE FROM %s WHERE status IN ('completed','failed','stale') AND COALESCE(ended_at, last_seen_at) < ?`, table), ms(cutoff))
		}
		if err != nil {
			return int(total), err
		}
		n, _ := res.RowsAffected()
		total += n
	}
	// Prune the raw event log on the same horizon.
	if _, err := s.db.Exec(`DELETE FROM events WHERE ts < ?`, ms(cutoff)); err != nil {
		return int(total), err
	}
	return int(total), nil
}

// Ping verifies the database connection (used for /healthz).
func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}
