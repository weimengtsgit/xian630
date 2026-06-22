# factory-server

Local orchestration API for the intelligent software factory MVP. Drives the
fixed six-step generation pipeline (requirement → design → code → test → image →
deploy) over a SQLite store and exposes the REST + SSE API the portal consumes.

## Build & run

```bash
make test
make build
./bin/factory-server                       # http://127.0.0.1:8787
```

For the full end-to-end local loop (deterministic, no real Claude CLI needed):

```bash
FACTORY_DBPATH=/tmp/software-factory.db \
FACTORY_WORKSPACE_ROOT=.. \
FACTORY_FAKE_CLAUDE=1 \
./bin/factory-server
```

`FACTORY_FAKE_CLAUDE=1` fakes the **generation pipeline steps**
(`requirement_analysis`, `solution_design`, `code_generation`, …) through a
deterministic fake runner that writes valid `output.json` artifacts and emits a
buildable generated app; the factory steps still run real `npm` + `podman`.

The requirement **clarification product path intentionally does NOT use the
fake runner** — it uses the real local Claude Code CLI, so streaming,
structured option cards, blueprint recommendations, and the requirement
summary exercise the same runner shape used in production-like local runs.
Tests inject a fake clarifier; the product path does not. Leave
`FACTORY_FAKE_CLAUDE` unset when exercising clarification end-to-end (see
[../docs/software-factory-local-runbook.md](../docs/software-factory-local-runbook.md)
→ "Requirement Clarification Flow").

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FACTORY_ADDR` | `127.0.0.1:8787` | listen address |
| `FACTORY_DBPATH` | `~/.software-factory/state.db` | SQLite database path |
| `FACTORY_WORKSPACE_ROOT` | `.` | workspace root (apps under `generated-apps/`, `scene/`) |
| `FACTORY_CC_STATUS_BASE_URL` | `http://127.0.0.1:8765` | cc-status observation API |
| `FACTORY_ARTIFACT_ROOT` | `.factory-runs` | job step artifacts (`output.json`, logs) |
| `FACTORY_LOG_PATH` | `.factory-runs/factory-server.jsonl` | JSONL runtime event log |
| `FACTORY_LOG_MAX_BYTES` | `10485760` | rotate log after this many bytes |
| `FACTORY_LOG_MAX_BACKUPS` | `5` | rotated `.N` files to keep |
| `FACTORY_FAKE_CLAUDE` | unset | `1`/`true`/`yes`/`on` → deterministic fake claude runner |

## Logs

`factory-server` appends lightweight JSONL runtime events to
`FACTORY_LOG_PATH` and rotates the file by size. Large Claude stdout/stderr
artifacts remain under `.factory-runs/jobs/<job-id>/<step>/attempt-<n>/`.

```bash
tail -f .factory-runs/factory-server.jsonl
```

## API

CORS is enabled on every response (origin `*`, methods `GET,POST,PATCH,DELETE,OPTIONS`,
header `Content-Type`), so the portal (Vite, `localhost:3001`) can call
factory-server directly from the browser.

- `GET /healthz`
- `GET /api/apps` · `GET /api/apps/:id` · `POST /api/apps/:id/{start,stop,rebuild}`
- `GET /api/agents` · `PATCH /api/agents/:id` · `GET /api/agents/:id/runs`
- `POST /api/jobs` · `GET /api/jobs` · `GET /api/jobs/:id`
- `GET /api/jobs/:id/steps` · `GET /api/jobs/:id/artifacts`
- `POST /api/jobs/:id/{cancel,answer,retry-current-step}`
- `GET /api/artifacts/:id/content`
- `GET /api/events` (SSE)
