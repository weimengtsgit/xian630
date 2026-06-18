# xian630

Intelligent software factory MVP — a local, loopback-only stack that turns a
natural-language prompt into a deployed generated application.

Three services compose the system:

- **cc-status** — observes Claude Code session/agent/skill lifecycle via hooks
  and exposes them as REST + SSE (`:8765`).
- **factory-server** — the orchestration API: drives the fixed six-step
  generation pipeline over a SQLite store, runs `claude`, `npm` and `podman`,
  and serves the REST + SSE API the portal consumes (`:8787`).
- **sf-portal-mvp** — the React/Vite front end (`:3001`), talking to factory-server
  (CORS enabled).

For the full local bring-up — build/run order, `FACTORY_FAKE_CLAUDE=1`
deterministic end-to-end mode, API checks and env vars — see
[docs/software-factory-local-runbook.md](docs/software-factory-local-runbook.md).
