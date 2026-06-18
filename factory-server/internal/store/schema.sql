-- Schema for the intelligent software factory (factory-server).
--
-- All timestamp columns are INTEGER unix milliseconds. Enum columns are TEXT
-- and mirror the corresponding string types in internal/model.

CREATE TABLE IF NOT EXISTS applications (
    id            TEXT    PRIMARY KEY,
    slug          TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    type          TEXT    NOT NULL,
    source        TEXT    NOT NULL,            -- preset | generated
    description   TEXT    NOT NULL DEFAULT '',
    path          TEXT    NOT NULL DEFAULT '',
    manifest_path TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL,            -- stopped|running|error|building|missing
    runtime_url   TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    id                TEXT    PRIMARY KEY,
    key               TEXT    NOT NULL UNIQUE,
    name              TEXT    NOT NULL,
    role              TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    claude_agent_name TEXT    NOT NULL DEFAULT '',
    skills_json       TEXT    NOT NULL DEFAULT '',
    enabled           INTEGER NOT NULL DEFAULT 1,
    sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
    id                TEXT    PRIMARY KEY,
    user_prompt       TEXT    NOT NULL,
    normalized_prompt TEXT    NOT NULL DEFAULT '',
    app_slug          TEXT    NOT NULL DEFAULT '',
    app_name          TEXT    NOT NULL DEFAULT '',
    status            TEXT    NOT NULL,        -- draft|queued|running|waiting_user|failed|completed|canceled
    current_step_kind TEXT    NOT NULL DEFAULT '',
    created_app_id    TEXT    NOT NULL DEFAULT '',
    lock_owner        TEXT    NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    started_at        INTEGER,
    ended_at          INTEGER,
    updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_steps (
    id                  TEXT    PRIMARY KEY,
    job_id              TEXT    NOT NULL,
    kind                TEXT    NOT NULL,
    seq                 INTEGER NOT NULL,
    agent_key           TEXT    NOT NULL DEFAULT '',
    status              TEXT    NOT NULL,      -- pending|running|waiting_user|succeeded|failed|skipped|canceled
    attempt             INTEGER NOT NULL DEFAULT 0,
    started_at          INTEGER,
    ended_at            INTEGER,
    needs_user_input    INTEGER NOT NULL DEFAULT 0,
    user_prompt         TEXT    NOT NULL DEFAULT '',
    error_code          TEXT    NOT NULL DEFAULT '',
    error_message       TEXT    NOT NULL DEFAULT '',
    claude_session_id   TEXT    NOT NULL DEFAULT '',
    cc_status_session_id TEXT   NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS artifacts (
    id         TEXT    PRIMARY KEY,
    job_id     TEXT    NOT NULL,
    step_id    TEXT    NOT NULL,
    attempt    INTEGER NOT NULL DEFAULT 0,
    kind       TEXT    NOT NULL,
    path       TEXT    NOT NULL DEFAULT '',
    summary    TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
    id             TEXT    PRIMARY KEY,
    app_id         TEXT    NOT NULL,
    job_id         TEXT    NOT NULL,
    image_name     TEXT    NOT NULL DEFAULT '',
    image_tag      TEXT    NOT NULL DEFAULT '',
    container_name TEXT    NOT NULL DEFAULT '',
    host_port      INTEGER NOT NULL DEFAULT 0,
    container_port INTEGER NOT NULL DEFAULT 0,
    url            TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL,           -- running|stopped|failed
    created_at     INTEGER NOT NULL,
    started_at     INTEGER,
    stopped_at     INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
    id             TEXT    PRIMARY KEY,
    job_id         TEXT,
    role           TEXT    NOT NULL,
    content        TEXT    NOT NULL DEFAULT '',
    metadata_json  TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL
);
