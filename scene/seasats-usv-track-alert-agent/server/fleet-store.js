import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(new URL("./data/fleet.sqlite", import.meta.url).pathname);
mkdirSync(dirname(databasePath), { recursive: true });

export const fleetDb = new DatabaseSync(databasePath);
fleetDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS fleet_sync_state (
    source TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    total_records INTEGER NOT NULL DEFAULT 0,
    page_size INTEGER NOT NULL DEFAULT 1000,
    next_page INTEGER NOT NULL DEFAULT 1,
    fetched_rows INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_vessel_snapshot (
    mmsi TEXT PRIMARY KEY,
    name TEXT,
    latest_time TEXT,
    lon REAL,
    lat REAL,
    speed_kn REAL,
    course_deg REAL,
    heading REAL,
    nav_status TEXT,
    raw_type_code TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT,
    source_rows INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS fleet_vessel_latest_time_idx ON fleet_vessel_snapshot(latest_time DESC);
`);

const upsertVessel = fleetDb.prepare(`
  INSERT INTO fleet_vessel_snapshot (
    mmsi, name, latest_time, lon, lat, speed_kn, course_deg, heading, nav_status,
    raw_type_code, first_seen_at, last_seen_at, source_rows
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(mmsi) DO UPDATE SET
    name = COALESCE(excluded.name, fleet_vessel_snapshot.name),
    latest_time = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time > fleet_vessel_snapshot.latest_time THEN excluded.latest_time ELSE fleet_vessel_snapshot.latest_time END,
    lon = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time >= fleet_vessel_snapshot.latest_time THEN excluded.lon ELSE fleet_vessel_snapshot.lon END,
    lat = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time >= fleet_vessel_snapshot.latest_time THEN excluded.lat ELSE fleet_vessel_snapshot.lat END,
    speed_kn = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time >= fleet_vessel_snapshot.latest_time THEN excluded.speed_kn ELSE fleet_vessel_snapshot.speed_kn END,
    course_deg = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time >= fleet_vessel_snapshot.latest_time THEN excluded.course_deg ELSE fleet_vessel_snapshot.course_deg END,
    heading = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time >= fleet_vessel_snapshot.latest_time THEN excluded.heading ELSE fleet_vessel_snapshot.heading END,
    nav_status = CASE WHEN fleet_vessel_snapshot.latest_time IS NULL OR excluded.latest_time >= fleet_vessel_snapshot.latest_time THEN excluded.nav_status ELSE fleet_vessel_snapshot.nav_status END,
    raw_type_code = COALESCE(excluded.raw_type_code, fleet_vessel_snapshot.raw_type_code),
    first_seen_at = MIN(fleet_vessel_snapshot.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(fleet_vessel_snapshot.last_seen_at, excluded.last_seen_at),
    source_rows = fleet_vessel_snapshot.source_rows + 1
`);

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoOrNull(value) {
  const text = textOrNull(value);
  if (!text) return null;
  const date = new Date(text.includes("T") && !/[zZ]|[+-]\d\d:\d\d$/.test(text) ? `${text}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function writeAisRows(rows) {
  fleetDb.exec("BEGIN");
  try {
    for (const row of rows) {
      const mmsi = textOrNull(row.mmsi);
      const time = isoOrNull(row.startTime || row.dataUpdateTime);
      if (!mmsi || !time) continue;
      upsertVessel.run(
        mmsi, textOrNull(row.shipName), time, numberOrNull(row.longitude), numberOrNull(row.latitude),
        numberOrNull(row.sog), numberOrNull(row.courseOverGround), numberOrNull(row.trueHeading),
        textOrNull(row.navigationalStatus), textOrNull(row.typeCode), time, time,
      );
    }
    fleetDb.exec("COMMIT");
  } catch (error) {
    fleetDb.exec("ROLLBACK");
    throw error;
  }
}

export function readSyncState() {
  return fleetDb.prepare("SELECT * FROM fleet_sync_state WHERE source = 'RawAISData'").get() || null;
}

export function beginOrResumeSync({ totalRecords, pageSize }) {
  const existing = readSyncState();
  const now = new Date().toISOString();
  if (existing?.status === "running") return existing;
  fleetDb.prepare(`
    INSERT INTO fleet_sync_state (source, status, total_records, page_size, next_page, fetched_rows, started_at, completed_at, updated_at)
    VALUES ('RawAISData', 'running', ?, ?, 1, 0, ?, NULL, ?)
    ON CONFLICT(source) DO UPDATE SET status='running', total_records=excluded.total_records, page_size=excluded.page_size,
      next_page=1, fetched_rows=0, started_at=excluded.started_at, completed_at=NULL, updated_at=excluded.updated_at
  `).run(totalRecords, pageSize, now, now);
  return readSyncState();
}

export function markPageSynced({ page, rows }) {
  fleetDb.prepare("UPDATE fleet_sync_state SET next_page=?, fetched_rows=fetched_rows + ?, updated_at=? WHERE source='RawAISData'")
    .run(page + 1, rows, new Date().toISOString());
}

export function markSyncComplete() {
  const now = new Date().toISOString();
  fleetDb.prepare("UPDATE fleet_sync_state SET status='complete', completed_at=?, updated_at=? WHERE source='RawAISData'").run(now, now);
}

export function readFleetSummary({ limit = 100000 } = {}) {
  const state = readSyncState();
  const rows = fleetDb.prepare("SELECT mmsi, name, latest_time, lon, lat, speed_kn, course_deg, raw_type_code FROM fleet_vessel_snapshot ORDER BY latest_time DESC LIMIT ?").all(limit);
  const total = fleetDb.prepare("SELECT count(*) AS count FROM fleet_vessel_snapshot").get().count;
  return { state, rows, total };
}
