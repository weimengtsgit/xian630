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

`FACTORY_FAKE_CLAUDE=1` routes the claude-mode steps through a deterministic
fake runner that writes valid `output.json` artifacts and emits a buildable
generated app; the factory steps still run real `npm` + `podman`. See
[../docs/software-factory-local-runbook.md](../docs/software-factory-local-runbook.md)
for the complete bring-up.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FACTORY_ADDR` | `127.0.0.1:8787` | listen address |
| `FACTORY_DBPATH` | `~/.software-factory/state.db` | SQLite database path |
| `FACTORY_WORKSPACE_ROOT` | `.` | workspace root (apps under `generated-apps/`, `scene/`) |
| `FACTORY_CC_STATUS_BASE_URL` | `http://127.0.0.1:8765` | cc-status observation API |
| `FACTORY_ARTIFACT_ROOT` | `.factory-runs` | job step artifacts (`output.json`, logs) |
| `FACTORY_FAKE_CLAUDE` | unset | `1`/`true`/`yes`/`on` → deterministic fake claude runner |

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
