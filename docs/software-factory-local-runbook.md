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

FACTORY_DBPATH=/tmp/software-factory.db \
FACTORY_WORKSPACE_ROOT=.. \
./bin/factory-server
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

## Requirement Clarification Flow

The portal no longer creates a generation job from the first chat message. The
first message creates a **clarification session** instead; a generation job is
only created after the user confirms the recommended requirement.

### Start order

1. Start **cc-status** (section 1).
2. Start **factory-server** with `FACTORY_FAKE_CLAUDE` **unset** — the real
   clarification runner uses the local Claude Code CLI. `FACTORY_FAKE_CLAUDE=1`
   is NOT used for clarification; see
   [factory-server/README.md](../factory-server/README.md) for the boundary.
3. Start **sf-portal-mvp** (section 3).

### Manual acceptance scenario

1. In the portal chat input, enter exactly:

   ```
   生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用
   ```

2. The center clarification panel **streams analysis work-logs and structured
   option cards** — this is *not* an immediate job. The first message created a
   clarification session, not a generation pipeline.
3. Select or confirm the recommended options (the round-1 runner proposes a
   recommended option per question and may recommend a similar preset
   blueprint).
4. Click `确认并生成`.
5. A **Job appears only after confirmation**. It runs the fixed six-step
   pipeline:
   `requirement_analysis` → `solution_design` → `code_generation` →
   `test_verification` → `image_build` → `deployment`.
6. On success the generated app appears in the application list with
   `source=generated` and a deployment URL.

### 场景蓝本 catalog

During clarification the runner may recommend a similar preset **场景蓝本**
(scene blueprint) as a style/structure/interaction/data-model reference. The
catalog lives at
[`.claude/skills/requirement-clarification/blueprints.json`](../.claude/skills/requirement-clarification/blueprints.json)
and is derived from the `scene/<slug>/` directories (e.g.
`carrier-formation-replay`, `aircraft-carrier-track`, `east-sea-situation`,
`carrier-homeport-tide-window`, `carrier-deck-wind-calculator`,
`merchant-density-grid-alert`, `social-sighting-cluster-alert`).

Blueprints are **references only** — they are never copied. Generated apps are
original code written under `generated-apps/<slug>/`.

### Audit file locations

```text
factory-server/.factory-runs/clarifications/<session-id>/round-1/
factory-server/.factory-runs/jobs/<job-id>/requirement_analysis/attempt-1/
```

The clarification directory holds the runner's `input.json`, streamed
work-logs, structured options, and the emitted requirement summary per round.
The job directory holds each pipeline step's `output.json`, logs, and
artifacts.

The real clarification runner invokes Claude Code with
`--output-format stream-json --include-partial-messages --verbose`. Factory
consumes those token-level events internally, filters out hook/system events and
hidden `thinking_delta` content, then emits only safe `clarification.*` SSE
events to the portal. During the stream, Factory incrementally extracts
`workLog[].content` from the structured JSON being produced, so the UI can show
the auditable analysis text as it grows. It never forwards raw chain-of-thought.

### Known MVP limitation (reload)

Reloading the portal mid-clarification currently returns the center panel to
**empty**. The clarification session itself **persists server-side** — resume
by continuing the conversation (the next message or `/confirm` still works
against the same session id). This is an honest MVP limitation of the portal's
client-side session hydration, not a server-side data-loss bug.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FACTORY_ADDR` | `127.0.0.1:8787` | factory-server listen address |
| `FACTORY_DBPATH` | `~/.software-factory/state.db` | SQLite database path |
| `FACTORY_WORKSPACE_ROOT` | `.` | workspace root (apps live under `generated-apps/`, `scene/`) |
| `FACTORY_CC_STATUS_BASE_URL` | `http://127.0.0.1:8765` | cc-status observation API |
| `FACTORY_ARTIFACT_ROOT` | `.factory-runs` | job step artifacts (`output.json`, logs) |
| `FACTORY_LOG_PATH` | `.factory-runs/factory-server.jsonl` | factory-server JSONL runtime log |
| `FACTORY_LOG_MAX_BYTES` | `10485760` | rotate `FACTORY_LOG_PATH` after this many bytes |
| `FACTORY_LOG_MAX_BACKUPS` | `5` | number of rotated `FACTORY_LOG_PATH.N` files to keep |
| `FACTORY_FAKE_CLAUDE` | unset | `1`/`true`/`yes`/`on` enables the deterministic fake claude runner |
| `VITE_FACTORY_API_BASE_URL` | `http://127.0.0.1:8787` | portal → factory-server base URL |

## Runtime logs

Both local services append JSONL runtime logs and rotate them by size.

```bash
tail -f ~/.cc-status/events.jsonl
tail -f factory-server/.factory-runs/factory-server.jsonl
```

Rotated files use numeric suffixes:

```text
events.jsonl.1
factory-server.jsonl.1
```

`cc-status` logs `server_started` and `hook_ingested` events. `factory-server`
logs `server_started`, `job_queued`, `step_started`, and `step_finished` events.
Large Claude stdout/stderr still lives under each attempt directory rather than
inside the JSONL event log.

## Generation job observability (operator view)

A confirmed generation job runs the fixed six-step pipeline:
`requirement_analysis` → `solution_design` → `code_generation` →
`test_verification` → `image_build` → `deployment`. Operators inspect progress
and artifacts through REST snapshots and the SSE delta stream; the portal always
hydrates from REST first, then applies SSE.

### Execution-record endpoints

`factory-server` exposes per-job, per-step observability. Replace `<id>` with
the job id and `<stepID>` with one of the six step ids above.

**Step summary** — one entry per step, used to hydrate the six cards:

```bash
curl http://127.0.0.1:8787/api/jobs/<id>/execution-summary
```

Returns an array of per-step summaries, each shaped:

```json
[
  {
    "step_id": "requirement_analysis",
    "latest_attempt": 1,
    "latest_record": { "kind": "summary", "content": "..." }
  }
]
```

**Step execution records** — ascending-sequence records for ONE step + attempt
(drawer pagination; loaded only when the drawer opens):

```bash
curl 'http://127.0.0.1:8787/api/jobs/<id>/steps/<stepID>/execution-records?attempt=1&limit=200'
# next page: &before_sequence=<last_seq_from_prev_page>
```

A missing step or a step not owned by the job returns `404`.

**Artifacts** — list and read content:

```bash
curl http://127.0.0.1:8787/api/jobs/<id>/artifacts
curl http://127.0.0.1:8787/api/artifacts/<artifactID>/content   # served as TEXT
```

Artifact content is restricted to roots under `.factory-runs` (path-traversal
protected); only artifact ids registered to the job resolve.

### What operators see vs. what is hidden

Claude stages (`requirement_analysis`, `solution_design`, `code_generation`)
record only **auditable** activity:

- safe tool use (`Read`/`Grep`/`Glob`/`Edit`/`Write`) → an `activity` record
  carrying a **redacted relative path**;
- explicit **public** `workLog` / structured conclusions → a `summary` record.

Hidden `thinking`, `reasoning`, and chain-of-thought content is **never**
recorded or streamed. If an operator expects to see model reasoning in the
drawer, it is intentionally absent — that is the security boundary, not a bug.

Command stages (`test_verification`, `image_build`, `deployment`) record the
**real** `command_stdout` / `command_stderr`, streamed live (batched when a
chunk exceeds 4 KiB or 100 ms elapses).

Record `kind` values: `system`, `activity`, `summary`, `command_stdout`,
`command_stderr`, `error`.

### SSE delta stream

The portal subscribes to the job's SSE stream. The execution-record event type
is `step.record.appended`; its `data` is one persisted record. The envelope
carries a monotonic `seq` the frontend uses for **gap detection** — on a missed
`seq` it re-hydrates from REST (see Recovery below). SSE never carries file
content or hidden reasoning.

### Redaction

Before any record or artifact is persisted, credential-shaped values are masked
to `[REDACTED]`. Redaction matches, case-insensitively, the keys `api_key`,
`token`, `secret`, `password`, `authorization` in both `key=value` and HTTP
header forms. Operational `input.json`, `prompt.md`, and `output.json` are
**never modified in place** — audit writes a separate redacted copy under
`attempt-N/audit/` and registers it as an artifact. Command `stdout.log` /
`stderr.log` are written directly, already redacted.

### Text artifact cap (10 MiB tail retention)

A single text artifact is capped at **10 MiB**. When content exceeds the cap,
the server keeps the **newest** 10 MiB (UTF-8-safe on the boundary) and prefixes
it:

```
[TRUNCATED: retained latest 10485760 bytes]
```

The truncation flag is set on the artifact, so operators can tell a capped log
from a complete one.

### Retry history

Cards show the **latest** attempt by default. After a retry, older attempts are
**preserved, not overwritten**; operators view them via the drawer's attempt
selector. Cancel is offered only for the currently **running** step and cancels
the **whole job**; Retry is offered only for the **latest attempt** of the
currently **failed** step.

### Recovery (reload / reconnect)

On browser reload, SSE reconnect, or a detected `seq` gap, the portal re-fetches
REST snapshots — execution-summary (cards), per-step records (drawer), and the
artifact list — **before** applying any new SSE deltas. Detailed
execution-records are paged per step + attempt and fetched only when the drawer
opens, so a reload does not pull every step's full history eagerly.

## Notes / known constraints

- Podman must be running for `image_build` and `deployment` to succeed.
- Real-Claude generation requires an authenticated local `claude` CLI and may
  pause in `waiting_user` when the agent asks clarification questions.
- The repository may carry unrelated dirty/staged files; do not run broad
  `git add .`.
