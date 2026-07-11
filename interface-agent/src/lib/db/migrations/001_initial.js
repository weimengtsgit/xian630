/**
 * Migration 001 — initial schema for the interface-agent versioning feature.
 *
 * Six domain tables (spec §数据模型):
 *   interface_design_sessions, interface_draft_versions,
 *   interface_generation_requests, interface_session_events,
 *   interface_shares, interface_deliveries
 *
 * Design notes:
 *   - sessions <-> versions is a deferred FK cycle (a session points at its
 *     mainline head / confirmed version; a version belongs to a session).
 *     `DEFERRABLE INITIALLY DEFERRED` lets a transaction insert both rows in
 *     order and only validate the cycle at commit.
 *   - versions reference themselves (parent_version_id) and generation
 *     requests <-> versions form another cycle (result_version_id /
 *     generation_request_id). Only the cycle that is bootstrapped mid
 *     transaction needs DEFERRABLE; we mark the session->version legs.
 *   - `(parent_version_id, branch_sequence)` is UNIQUE; root versions have a
 *     NULL parent, and SQLite treats multiple NULLs as distinct, so multiple
 *     roots are allowed (as expected).
 *   - "at most one active session per project_key" is enforced by a partial
 *     unique index WHERE status='active'.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE interface_design_sessions (
      id                       TEXT PRIMARY KEY,
      project_key              TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'active'
                                 CHECK(status IN ('active','archived','deleted')),
      mainline_head_version_id TEXT REFERENCES interface_draft_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
      confirmed_version_id     TEXT REFERENCES interface_draft_versions(id)
                                 DEFERRABLE INITIALLY DEFERRED,
      row_version              INTEGER NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      archived_at              TEXT
    );

    CREATE INDEX idx_sessions_project_key
      ON interface_design_sessions(project_key);
    CREATE UNIQUE INDEX idx_sessions_active_project
      ON interface_design_sessions(project_key) WHERE status = 'active';

    CREATE TABLE interface_draft_versions (
      id                    TEXT PRIMARY KEY,
      session_id            TEXT NOT NULL
                              REFERENCES interface_design_sessions(id) ON DELETE CASCADE,
      parent_version_id     TEXT REFERENCES interface_draft_versions(id),
      version_label         TEXT NOT NULL,
      mainline_sequence     INTEGER,
      branch_sequence       INTEGER,
      label_path_json       TEXT,
      title                 TEXT,
      generation_request_id TEXT REFERENCES interface_generation_requests(id),
      source_version_id     TEXT,
      artifact_path         TEXT NOT NULL,
      content_hash          TEXT NOT NULL,
      byte_size             INTEGER,
      archived_at           TEXT,
      created_at            TEXT NOT NULL,
      created_by            TEXT
    );

    CREATE UNIQUE INDEX idx_versions_session_label
      ON interface_draft_versions(session_id, version_label);
    CREATE UNIQUE INDEX idx_versions_parent_branch
      ON interface_draft_versions(parent_version_id, branch_sequence);
    CREATE INDEX idx_versions_session ON interface_draft_versions(session_id);
    CREATE INDEX idx_versions_created ON interface_draft_versions(created_at);

    CREATE TABLE interface_generation_requests (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL
                         REFERENCES interface_design_sessions(id) ON DELETE CASCADE,
      base_version_id  TEXT REFERENCES interface_draft_versions(id),
      idempotency_key  TEXT NOT NULL,
      instruction      TEXT,
      status           TEXT NOT NULL DEFAULT 'queued'
                         CHECK(status IN ('queued','generating','saving','succeeded','failed')),
      result_version_id TEXT REFERENCES interface_draft_versions(id),
      error_code       TEXT,
      error_message    TEXT,
      created_at       TEXT NOT NULL,
      started_at       TEXT,
      finished_at      TEXT,
      created_by       TEXT
    );

    CREATE UNIQUE INDEX idx_genreq_session_idem
      ON interface_generation_requests(session_id, idempotency_key);
    CREATE INDEX idx_genreq_session ON interface_generation_requests(session_id);
    CREATE INDEX idx_genreq_status ON interface_generation_requests(status);

    CREATE TABLE interface_session_events (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL
                     REFERENCES interface_design_sessions(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      type         TEXT NOT NULL,
      payload_json TEXT,
      created_at   TEXT NOT NULL,
      created_by   TEXT
    );

    -- (session_id, seq) is both the uniqueness guard and the lookup index.
    CREATE UNIQUE INDEX idx_events_session_seq
      ON interface_session_events(session_id, seq);

    CREATE TABLE interface_shares (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL
                    REFERENCES interface_design_sessions(id) ON DELETE CASCADE,
      version_id  TEXT NOT NULL REFERENCES interface_draft_versions(id),
      token_hash  TEXT NOT NULL,
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT,
      revoked_at  TEXT
    );

    CREATE INDEX idx_shares_version  ON interface_shares(version_id);
    CREATE INDEX idx_shares_token    ON interface_shares(token_hash);

    CREATE TABLE interface_deliveries (
      id                          TEXT PRIMARY KEY,
      session_id                  TEXT NOT NULL
                                    REFERENCES interface_design_sessions(id) ON DELETE CASCADE,
      version_id                  TEXT NOT NULL REFERENCES interface_draft_versions(id),
      status                      TEXT NOT NULL DEFAULT 'pending'
                                    CHECK(status IN ('pending','delivering','delivered','failed','superseded')),
      attempts                    INTEGER NOT NULL DEFAULT 0,
      error_code                  TEXT,
      error_message               TEXT,
      idempotency_key             TEXT NOT NULL,
      superseded_by_delivery_id   TEXT REFERENCES interface_deliveries(id),
      created_at                  TEXT NOT NULL,
      updated_at                  TEXT NOT NULL
    );

    CREATE UNIQUE INDEX idx_deliveries_session_idem
      ON interface_deliveries(session_id, idempotency_key);
    CREATE INDEX idx_deliveries_session ON interface_deliveries(session_id);
    CREATE INDEX idx_deliveries_status  ON interface_deliveries(status);
  `);
}
