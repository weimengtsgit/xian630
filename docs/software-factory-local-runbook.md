# Software Factory — Local Runbook

End-to-end local bring-up of the intelligent software factory MVP: the
**cc-status** observation service, the **factory-server** orchestration API, and
the **sf-portal-mvp** front end. Verified commands for a clean checkout.

## Architecture (local)

```
cc-status (:8765)   ──observes──◀   claude CLI hooks
factory-server (:8787) ──orchestrates──▶  claude CLI + npm + podman (workspace)
sf-portal-mvp (:3001, Vite) ──HTTP/SSE──▶  factory-server  (CORS enabled)
```

`factory-server` serves the REST + SSE API the portal consumes. CORS headers
are injected on every response so the browser (portal served from
`localhost:3001`) may call `factory-server` at `127.0.0.1:8787` directly.

## Prerequisites

- Go 1.26+
- Node 20+ and npm
- Podman (rootless machine running) — required by the factory build/deploy steps
- (Optional) Claude Code CLI authenticated — only for real-Claude generation;
  the deterministic fake mode below needs no CLI

## 1. cc-status (observation)

cc-status records Claude Code session lifecycle via hooks. Build and run it:

```bash
cd cc-status
make build
./bin/cc-status serve                      # http://127.0.0.1:8765
```

To install the observational hooks into `~/.claude/settings.json` (one-time):

```bash
make install-local                         # copies binary to $GOPATH/bin
cc-status install                          # registers hooks
```

## 2. factory-server (orchestration)

```bash
cd ../factory-server
make build
FACTORY_DBPATH=/tmp/software-factory.db \
FACTORY_WORKSPACE_ROOT=.. \
FACTORY_FAKE_CLAUDE=1 \
./bin/factory-server                       # http://127.0.0.1:8787
```

`FACTORY_FAKE_CLAUDE=1` routes the three claude-mode steps
(`requirement_analysis`, `solution_design`, `code_generation`) through a
**deterministic fake runner** so the full six-step pipeline runs end-to-end
without a real Claude CLI: it writes valid `output.json` artifacts and emits a
minimal but genuinely buildable Vite + React app under
`generated-apps/factory-demo/`. The downstream factory steps
(`test_verification`, `image_build`, `deployment`) still run **real** `npm` and
`podman` against that generated app — that is intentional.

Leave `FACTORY_FAKE_CLAUDE` unset to use the real Claude CLI (requires local
`claude` auth). In real mode the three claude-mode steps run through the local
CLI, validate each step's `output.json`, and register the generated app before
the factory npm/podman steps continue.

## 3. sf-portal-mvp (front end)

```bash
cd ../sf-portal-mvp
npm install
npm run dev                                # http://localhost:3001
```

Open `http://localhost:3001`. The portal calls factory-server at
`http://127.0.0.1:8787` (override with `VITE_FACTORY_API_BASE_URL`). Because
factory-server sends permissive CORS headers, the cross-origin browser calls
succeed.

## API checks

With factory-server running:

```bash
curl http://127.0.0.1:8787/healthz         # {"ok":true}
curl http://127.0.0.1:8787/api/apps        # known applications
curl http://127.0.0.1:8787/api/agents      # agent registry
```

Verify CORS preflight from the portal origin:

```bash
curl -i -X OPTIONS http://127.0.0.1:8787/api/apps \
  -H 'Origin: http://localhost:3001' \
  -H 'Access-Control-Request-Method: POST'   # expect 204 + ACAO: *
```

## End-to-end acceptance (deterministic)

With all three services up and `FACTORY_FAKE_CLAUDE=1`, submit a generation job:

```bash
curl -X POST http://127.0.0.1:8787/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用"}'
```

Expected: the job walks all six steps to `completed`; the generated app card
appears in the portal with `source=generated` and a deployment URL once
deployment succeeds.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FACTORY_ADDR` | `127.0.0.1:8787` | factory-server listen address |
| `FACTORY_DBPATH` | `~/.software-factory/state.db` | SQLite database path |
| `FACTORY_WORKSPACE_ROOT` | `.` | workspace root (apps live under `generated-apps/`, `scene/`) |
| `FACTORY_CC_STATUS_BASE_URL` | `http://127.0.0.1:8765` | cc-status observation API |
| `FACTORY_ARTIFACT_ROOT` | `.factory-runs` | job step artifacts (`output.json`, logs) |
| `FACTORY_FAKE_CLAUDE` | unset | `1`/`true`/`yes`/`on` enables the deterministic fake claude runner |
| `VITE_FACTORY_API_BASE_URL` | `http://127.0.0.1:8787` | portal → factory-server base URL |

## Notes / known constraints

- Podman must be running for `image_build` and `deployment` to succeed.
- Real-Claude generation requires an authenticated local `claude` CLI and may
  pause in `waiting_user` when the agent asks clarification questions.
- The repository may carry unrelated dirty/staged files; do not run broad
  `git add .`.
