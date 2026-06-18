-- cc-status SQLite schema. All timestamps are INTEGER unix milliseconds.

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,           -- session_id
  cwd          TEXT,
  source       TEXT,
  model        TEXT,
  started_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at     INTEGER,
  status       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subagents (
  id                    TEXT PRIMARY KEY,  -- agent_id (falls back to uuid)
  session_id            TEXT NOT NULL,
  agent_id              TEXT,
  agent_type            TEXT,
  description           TEXT,
  status                TEXT NOT NULL,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  duration_ms           INTEGER,
  transcript_path       TEXT,
  last_assistant_message TEXT,
  model                 TEXT,
  total_tokens          INTEGER,
  tool_use_count        INTEGER,
  parent_tool_use_id    TEXT,
  last_seen_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_subagents_status  ON subagents(status);
CREATE INDEX IF NOT EXISTS idx_subagents_agent   ON subagents(agent_id);

CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  agent_id     TEXT,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL,              -- tool | slash
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_ms  INTEGER,
  tool_use_id  TEXT,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_session ON skills(session_id);
CREATE INDEX IF NOT EXISTS idx_skills_status  ON skills(status);

CREATE TABLE IF NOT EXISTS background_tasks (
  id            TEXT PRIMARY KEY,          -- session_id + ":" + task_id
  session_id    TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  type          TEXT,
  status        TEXT NOT NULL,
  description   TEXT,
  command       TEXT,
  agent_type    TEXT,
  tool          TEXT,
  name          TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bt_session ON background_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_bt_status  ON background_tasks(status);

CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  session_id      TEXT,
  hook_event_name TEXT NOT NULL,
  payload         TEXT NOT NULL             -- raw JSON
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
