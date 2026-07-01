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

## Dialogue Session Flow

The portal no longer creates a generation job from the first chat message. The
first message creates a **dialogue session** that classifies the user's intent
into one of two active routes: **existing-application reuse** or **application
generation** (a child clarification session). Business-processing agent
drafting is a dormant future route that is not exposed in this phase. Selecting
a route locks it; a new request needs a new dialogue.

### Start order

1. Start **cc-status** (section 1).
2. Start **factory-server** with `FACTORY_FAKE_CLAUDE` **unset** — the real
   dialogue/clarification runner uses the local Claude Code CLI.
   `FACTORY_FAKE_CLAUDE=1` is NOT used for dialogue routing or clarification;
   see [factory-server/README.md](../factory-server/README.md) for the boundary.
3. Start **sf-portal-mvp** (section 3).

### Manual flow 1 — existing-application reuse

1. In the portal chat input, enter a request that matches an existing preset
   application, e.g.:

   ```
   打开东海态势应用
   ```

2. The model infers the `existing_application_reuse` intent and emits a
   structured recommendation (`dialogue.application.recommended`) pointing at a
   configured preset application.
3. Confirm the route. The dialogue resolves and the recommended application can
   be opened or started directly — no generation job is created.

### Manual flow 2 — application generation (6-round adaptive clarification)

1. In the portal chat input, enter a new application request:

   ```
   生成一个航母编队近一个月航行轨迹和事件的东海地图复盘应用
   ```

2. The model infers the `application_generation` intent. Confirm the route; a
   child **clarification session** is created. The center panel **streams
   analysis work-logs and structured option cards** — this is *not* an
   immediate job.
3. The clarification is **adaptive and limited to 6 rounds**:
   - Rounds 1–4: at most **one** question per round, each with 2–3 options.
   - Round 5: **recommendation consolidation** — remaining decisions are listed
     with their recommended values for one-shot accept or targeted adjustment.
   - Round 6: a single-field adjustment, then the session reaches
     `ready_to_confirm`. There is **no seventh round**.
4. Click `确认并生成`.
5. A **Job appears only after confirmation**. It runs the fixed six-step
   pipeline:
   `requirement_analysis` → `solution_design` → `code_generation` →
   `test_verification` → `image_build` → `deployment`.
6. On success the generated app appears in the application list with
   `source=generated` and a deployment URL. Its name is Factory-owned: the model
   produces a normalized scenario name and Factory appends a 4-char Base36
   serial (e.g. `航母编队航迹复盘-K7M2`). No `demoN` names.

### Assistant application request

Use a prompt such as:

```text
帮我创建一个告警分诊助手，能够收集告警、判断优先级并给出处置建议。
```

Expected:

1. The dialogue does not show a "配置业务 Agent" route.
2. If no existing application is a strong fit, the route enters
   `application_generation`.
3. The workbench starts requirement clarification for a runnable assistant
   application.
4. The final generated app appears in the application list as an application,
   not as a business-processing Agent entry.

### Scene catalog and hidden blueprints

Preset scene surfaces are governed by the single scene catalog at
[`.factory/scene-catalog.json`](../.factory/scene-catalog.json). Each scene is
assigned to exactly one surface:

- `application` (listed preset apps): `carrier-formation-replay`,
  `aircraft-carrier-track`, `east-sea-situation`.
- `blueprint` (hidden internal references): `carrier-homeport-tide-window`,
  `carrier-deck-wind-calculator`, `merchant-density-grid-alert`,
  `social-sighting-cluster-alert` (display name 开源社区异常监测).

`preset-apps.json` no longer drives runtime display or routing. **Blueprints are
internal and hidden** — they are never presented to the user as a product
constraint, an unavailable capability, or an existing application to open. They
may guide generation internally as references only; generated apps are original
code written under `generated-apps/<slug>/`, never copied.

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

Reloading the portal mid-dialogue/mid-clarification currently returns the
center panel to **empty**. The dialogue and clarification sessions themselves
**persist server-side** — resume by continuing the conversation (the next
message or `/confirm` still works against the same session id). This is an
honest MVP limitation of the portal's client-side session hydration, not a
server-side data-loss bug.

### Migration smoke check (historical clarification sessions)

When `factory-server` starts against a database created by an earlier (pre-
dialogue) build, legacy clarification sessions are **backfilled** into
`application_generation` dialogues on startup, and the run is **idempotent** —
restarting the server does not duplicate or rewrite already-migrated rows.

Verify after first startup:

```bash
curl http://127.0.0.1:8787/api/dialogues      # backfilled dialogues present
# restart factory-server, then re-run the same call — row count and ids unchanged
```

A legacy clarification session that had already produced a job appears under its
backfilled dialogue as a resolved `application_generation` route.

### Safe SSE event families

The portal subscribes to `/api/events` and consumes only these SSE event
families:

```text
app.*          job.*          step.*         deployment.*
dialogue.*     clarification.*
```

The `dialogue.*` family includes `dialogue.created`, `dialogue.intent.updated`,
`dialogue.application.recommended`, `dialogue.route.confirmed`,
`dialogue.agent_draft.updated`, `dialogue.agent.created`,
`dialogue.clarification.updated`, `dialogue.resolved`, `dialogue.abandoned`,
`dialogue.deleted`, `dialogue.archived`, `dialogue.forked`,
`dialogue.message.accepted`, `dialogue.turn.*`, and `dialogue.change.proposed`.
The continuing-session trace events (`dialogue.work_trace`) are carried on the
**dialogue-scoped** `/api/dialogues/:id/work-trace/stream` (see the Workbench
section), not the global stream. `clarification.*` is retained as a
legacy/backfill family.
Internal blueprint slugs, raw Claude `stdout`/`stderr`, and `thinking_delta`
content are **never** forwarded to the browser.

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
| `FACTORY_MAX_CONCURRENT_JOBS` | `3` | bounded scheduler: max generation jobs run in parallel. Clamped to **1–16** on startup (values below 1 become 1; above 16 become 16). Independent applications run concurrently; a second job for an app already being generated is held queued until the first reaches a terminal state (same-app serialization) |
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
record **auditable** activity (parsed from the real Claude Code CLI
`--output-format stream-json` output — each line is a top-level NDJSON event;
content blocks live nested under `assistant.message.content[]`):

- safe tool use (`Read`/`Grep`/`Glob`) → an `activity` record carrying a
  **redacted relative path**;
- `Write`/`Edit` tool use → a `file_delta` record (`新建/编辑 <path> +N -M`)
  so the drawer shows the live per-file code-generation progress;
- explicit **public** `workLog` / structured conclusions → a `summary` record;
- the model's **`thinking`/reasoning blocks → `thinking` records** (方案 B: the
  original "never show hidden reasoning" boundary is relaxed). Thinking is still
  redacted for credentials (→ `[REDACTED]`) at the persistence chokepoint and
  chunked to ≤4 KiB.

These `thinking` / `file_delta` records appear **only in real-CLI mode**
(`FACTORY_FAKE_CLAUDE` unset); `FakeClaudeRunner` does not produce them.

A live capture also showed the model sometimes wraps its final JSON answer in a
markdown code fence (` ```json … ``` `); the runner strips such a fence before
writing `output.json` so stage validation still passes.

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

## Continuous Conversation Workbench (continuing sessions, traces, retention)

Once a dialogue's first application is generated and deployed, the dialogue
**stays open** in the `active` continuing phase (a legacy `resolved` dialogue is
backfilled to `active` on startup). Follow-up modification/inquiry turns are
processed asynchronously: `POST /api/dialogues/:id/messages` returns
**202 Accepted** with `{dialogueId, turnId, acceptedAt}` and a per-dialogue turn
worker drains turns in arrival order. In-flight turns can be canceled via
`POST /api/dialogues/:id/turns/:turnId/cancel`.

### Bounded concurrent generation

Generation jobs are scheduled by a bounded worker pool. Control it with
`FACTORY_MAX_CONCURRENT_JOBS` (default **3**, clamped to **1–16**).

- **Independent applications run concurrently.** A generation for app B is not
  blocked by an in-flight generation for app A.
- **Same-app generation is serialized.** A second job for an app that already has
  a running/queued job is held back by `ClaimNextRunnableJob` (it serializes on
  `app_slug`); it becomes claimable only once the prior job reaches a terminal
  state. This guarantees a versioned candidate build (v2) does not race the
  currently-effective version (v1) of the same app.

### Versioned builds, promotion, and retain-on-failure

Each generation produces an `application_versions` row (`queued` → `building` →
`effective`/`failed`/`superseded`). On a successful deployment the candidate is
**promoted** (prior effective is superseded in one transaction). If the
candidate's **health check fails**, the prior effective version is **retained**:
it stays `effective` and its deployment stays `running` — the failed candidate is
recorded as `failed` in the lineage for audit. A version can be rolled back via
`POST /api/apps/:id/rollback` (`{"confirm":true,"version_id":"..."}`), which
re-promotes the previous effective version through a health check.

### Visible work-trace replay (per dialogue)

The model's auditable process flows ONLY through the dialogue-scoped work-trace,
never through the global `/api/events` stream:

```bash
# REST hydration — ascending by sequence, filtered to ONE dialogue
curl http://127.0.0.1:8787/api/dialogues/<id>/work-trace
curl 'http://127.0.0.1:8787/api/dialogues/<id>/work-trace?afterSequence=5'

# SSE stream — replays persisted rows first, then forwards live events
curl -N http://127.0.0.1:8787/api/dialogues/<id>/work-trace/stream
```

**Reconnect / `Last-Event-ID`:** each SSE frame carries the row's `sequence` as
the SSE `id:` line. On reconnect, send the last received sequence as the
`Last-Event-ID` request header (or the `afterSequence` query param) and replay
resumes from the NEXT sequence — already-seen rows are never re-sent. When both
are set, the **header wins**. The stream replays persisted rows first, then
switches to live forwarding, de-duplicating across the replay→live boundary.

**Isolation:** both endpoints filter strictly to `:id`. A trace event for
dialogue B is never delivered on dialogue A's stream — enforced server-side at
both the REST query and the SSE live forwarder, which also store-validates every
live event (an event not present in `work_trace_events` is dropped, so a
misbehaving producer cannot inject un-persisted data).

### Attachment caps and redaction (Constraint #9)

Raw chain-of-thought (`thinking` / `thinking_delta`), raw request/response
bodies, and credentials **never reach** the trace, the SSE stream, or stored
attachments:

- The trace store is a single trust boundary: `AppendDialogueTrace` rejects any
  type outside the allowlist (`intent`, `approach`, `assumption`,
  `clarification`, `tool`, `data`, `validation`, `change_confirmation`, `task`,
  `version`, `deployment`, `warning`, `error`, `assistant_output`). `thinking`,
  `raw_request`, `raw_response`, and empty/credential-ish types are **rejected**
  (nothing is persisted).
- Even on an allowed type, sensitive JSON keys (`api_key`, `token`, `secret`,
  `password`, `authorization`, `credential`, `private_key`, … matched at any
  nesting depth, case-insensitively) are zeroed to `[redacted]` before insert.
- Per-payload size is capped and oversized payloads are truncated with a marker
  rather than stored whole. Text artifacts are tailed at **10 MiB** (see the
  generation-observability section above). Thinking emitted by the real CLI is
  dropped at the source in the trace-emission pipeline.

### Retention and explicit deletion

Audit history persists until **explicit** deletion:

- **Archiving** a dialogue (`POST /api/dialogues/:id/archive`) flips it to the
  `archived` phase and emits `dialogue.archived` — it shelves the conversation
  WITHOUT deleting anything (trace, versions, deployments, and job records all
  remain). It is idempotent.
- **Deleting an application** (`DELETE /api/apps/:id`) removes the
  `applications` row and its `deployments` in one transaction, but **preserves**
  audit history: the linked `jobs`, `job_steps`, `application_versions`, and
  `work_trace_events` rows remain readable (they orphan but are not purged).
- **Explicitly deleting a dialogue** (`DELETE /api/dialogues/:id`) removes the
  `dialogue_sessions` and `dialogue_messages` rows; linked jobs, apps, versions,
  and trace events are intentionally left untouched.
- **Semantic trace, version, and deployment records therefore persist until
  explicit dialogue deletion.** Attachments are always redacted and size-capped
  (Constraint #9). There is no automatic TTL purge of audit records.

### Migration smoke check (legacy dialogues)

When `factory-server` starts against a database from an earlier build:

- legacy `resolved` dialogues are backfilled to `active`
  (`BackfillResolvedDialoguesToActive`);
- the four `jobs` lineage columns (`dialogue_id`, `application_id`,
  `base_version_id`, `kind`) are added via `ensureColumn`;
- the `application_versions`, `dialogue_turns`, and `work_trace_events` tables
  are created (`CREATE TABLE IF NOT EXISTS`).

All of the above are **idempotent** — restarting the server does not duplicate or
rewrite already-migrated rows. Verify after first startup:

```bash
curl http://127.0.0.1:8787/api/dialogues      # backfilled dialogues present
# restart factory-server, re-run the same call — ids and statuses unchanged
```

## 界面解析 / 原型设计兼容键

Factory 仍使用内部 step kind `design_contract` 表示界面解析阶段，避免历史 job 和数据库迁移断裂。用户界面将该阶段展示为"界面解析/原型设计"。

执行输入以业务智能体完整设计方案为主：

- `businessDesign`
- `businessDesignArtifact`
- `confirmedRequirement`
- `generationProfile`
- `skills`
- `blueprintDocs`
- `collaborationSnapshot`

该步骤必须读取 `.claude/skills/prototype-design/SKILL.md`，默认生成静态首页原型，并在缺少原型风格、目标用户、目标平台或保真度时进入 `waiting_user`。

原型产物位于：

```text
.factory-runs/jobs/<job-id>/design_contract/attempt-<n>/prototype/
  index.html
  styles.css
  preview-manifest.json
  prototype-contract.json
```

确认原型后，下游步骤按 `hard_constraint` 使用；直接继续但不确认时，下游只能按 `reference` 使用。

## Notes / known constraints

- Podman must be running for `image_build` and `deployment` to succeed.
- Real-Claude generation requires an authenticated local `claude` CLI and may
  pause in `waiting_user` when the agent asks clarification questions.
- The repository may carry unrelated dirty/staged files; do not run broad
  `git add .`.
