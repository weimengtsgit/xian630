# cc-status

A small API server that lets you **query the status and details of Claude Code's
running agents, subagents and skills** — across all your `claude` CLI sessions.

It works by registering observational hooks in `~/.claude/settings.json` that
forward events to this server, which persists them in SQLite and exposes them as
REST resources plus a live Server-Sent Events stream.

> Scope: a lean MVP. Loopback-only, no auth, single-platform build. CI / Homebrew
> / multi-platform release are deferred to v2.

## How it works

```
 claude CLI session(s)
        │  (hooks fire on lifecycle events)
        ▼
 cc-status hook   ──POST──▶  cc-status serve  ──▶  SQLite (~/.cc-status/state.db)
 (subprocess)                  (HTTP + SSE)              ▲
        │                          │                      │
   exit 0, no stdout          REST queries        ghost reaper + TTL prune
```

We hook only the **bounded lifecycle events** (not every tool call), so the
per-event process spawn overhead stays low:

| Hook event          | What it gives us                                   |
|---------------------|----------------------------------------------------|
| `SessionStart/End`  | session lifecycle                                  |
| `UserPromptSubmit`  | session keep-alive + slash-skill detection         |
| `SubagentStart/Stop`| subagent lifecycle (agent_id, type, transcript)    |
| `PreToolUse` (Skill)| skill-tool start                                   |
| `PostToolUse` (Skill\|Agent) | skill end; subagent detail (model/tokens/duration) |
| `Stop`              | turn boundary (closes slash skills) + bg task sync |

## Quick start

```bash
make build                 # produces bin/cc-status
./bin/cc-status install    # inject hooks + start keep-alive daemon
```

Then restart any open Claude Code sessions. Trigger some agents/skills and query:

```bash
curl http://127.0.0.1:8765/running
curl http://127.0.0.1:8765/api/v1/sessions
curl http://127.0.0.1:8765/api/v1/agents?status=running
```

Uninstall:

```bash
./bin/cc-status uninstall
```

## Commands

```
cc-status serve [--addr HOST:PORT] [--db PATH]   run the API server (foreground)
cc-status hook                                   forward one hook payload (stdin → server)
cc-status install [--project] [--no-daemon]      inject hooks + start daemon
cc-status uninstall [--project]                  remove hooks + daemon
cc-status version
```

## API (v1)

All under `http://127.0.0.1:8765`. Filters: `?status=running|completed|failed|stale`,
`?limit=` , `?offset=`.

| Method | Path                                | Returns                                  |
|--------|-------------------------------------|------------------------------------------|
| GET    | `/healthz`                          | `{ok, version}`                          |
| GET    | `/running`                          | everything currently running/stale       |
| GET    | `/api/v1/sessions`                  | list sessions                            |
| GET    | `/api/v1/sessions/:id`              | one session                              |
| GET    | `/api/v1/sessions/:id/agents`       | subagents in a session                   |
| GET    | `/api/v1/sessions/:id/skills`       | skills in a session                      |
| GET    | `/api/v1/sessions/:id/tasks`        | background tasks in a session            |
| GET    | `/api/v1/agents`                    | list subagents                           |
| GET    | `/api/v1/agents/:id`                | one subagent (with merged detail)        |
| GET    | `/api/v1/agents/:id/skills`         | skills invoked inside a subagent         |
| GET    | `/api/v1/skills`                    | list skills                              |
| GET    | `/api/v1/skills/:id`                | one skill                                |
| GET    | `/api/v1/tasks`                     | list background tasks                    |
| GET    | `/api/v1/tasks/:id`                 | one background task                      |
| GET    | `/api/v1/events?since=<seq>`        | SSE stream of live events (+ catch-up)   |
| POST   | `/api/v1/events/ingest`             | (internal) hook CLI posts here           |

See `examples/query.sh`.

## Configuration (env)

| Var                          | Default                    | Meaning                          |
|------------------------------|----------------------------|----------------------------------|
| `CC_STATUS_ADDR`             | `127.0.0.1:8765`           | listen address (loopback)        |
| `CC_STATUS_DBPATH`           | `~/.cc-status/state.db`    | SQLite path                      |
| `CC_STATUS_GHOST_TIMEOUT`    | `5m`                       | running w/o update → stale       |
| `CC_STATUS_TTL`              | `168h` (7d)                | completed/stale prune horizon    |
| `CC_STATUS_SCAN_INTERVAL`    | `60s`                      | skill-name scan refresh          |
| `CC_STATUS_LOG_PATH`         | `~/.cc-status/events.jsonl`| JSONL runtime event log          |
| `CC_STATUS_LOG_MAX_BYTES`    | `10485760`                 | rotate log after this many bytes |
| `CC_STATUS_LOG_MAX_BACKUPS`  | `5`                        | rotated `.N` files to keep       |

## Logs

`cc-status` appends lightweight JSONL events to `CC_STATUS_LOG_PATH` and rotates
the file by size. The log intentionally excludes prompt content and tokens; full
hook payloads remain in SQLite.

```bash
tail -f ~/.cc-status/events.jsonl
```

## Design notes & limitations

- **Subagent details** (model, tokens, duration) come from `PostToolUse(Agent)`
  `tool_response`, merged onto the lifecycle from `SubagentStart/Stop`.
- **Skills**: the `Skill` tool path is exact. Slash-command skills (e.g. `/tdd`)
  are detected heuristically via `UserPromptSubmit` matched against skill names
  scanned from `~/.claude/skills` and plugin dirs; their end is approximated at
  the turn boundary. Built-in slash commands are not counted as skills.
- **Reliability**: best-effort delivery. If the server is briefly unreachable
  the hook drops the event (logs to stderr). Entities not updated within
  `CC_STATUS_GHOST_TIMEOUT` are reaped to `stale` so "running" never lies.
- **Security**: loopback-only, **no auth**. Any local process can read status or
  post events. Add a shared-secret token before exposing beyond localhost.
- **No transcript tailing / no per-tool-call tree** in v1 (see design record).

## Development

```bash
make vet test     # go vet + unit tests (cmd + internal only)
make fmt
```

Pure-Go SQLite (`modernc.org/sqlite`) keeps a single static binary with no C
toolchain. Routing/JSON/SSE use only the standard library.
