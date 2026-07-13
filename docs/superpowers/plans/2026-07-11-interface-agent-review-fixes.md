# Interface Agent Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining interface-agent correctness, recovery, deployment, and contract findings without changing agent-pipeline.

**Architecture:** Keep the existing Express/SQLite boundaries. Recovery codes identify one session before scrypt verification; version state validation is enforced at the repository transaction boundary; preview routes share one handler; deployment backup uses the existing Node SQLite dependency.

**Tech Stack:** Node.js, Express, better-sqlite3, Vitest, Supertest.

## Global Constraints

- Do not modify `agent-pipeline`.
- Preserve existing edit-token hashes and cookie authentication.
- Keep version HTML immutable and sandboxed.
- Use at-least-once external processing with stable idempotency keys; do not claim single-service exactly-once guarantees.

---

### Task 1: Targeted Independent-Session Recovery

**Files:**
- Modify: `interface-agent/src/lib/auth/routes.js`
- Modify: `interface-agent/src/lib/sessions/routes.js`
- Modify: `interface-agent/src/lib/db/repository.js`
- Modify: `interface-agent/public/app.js`
- Test: `interface-agent/test/auth.test.js`
- Test: `interface-agent/test/task7-frontend.test.js`

**Interfaces:**
- Produces: recovery code `<projectKey>.<editToken>` and `POST /api/auth/restore { recoveryCode }`.

- [ ] Add tests proving restore queries one session, rejects malformed codes, and the frontend sends `recoveryCode`.
- [ ] Run the focused tests and confirm they fail for the missing targeted lookup.
- [ ] Replace the all-session scan with `getSession(sessionId)` plus one `verifyEditToken` call; update independent-session response/UI.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Version State Integrity and Preview Compatibility

**Files:**
- Modify: `interface-agent/src/lib/db/repository.js`
- Modify: `interface-agent/src/lib/confirmations/routes.js`
- Modify: `interface-agent/src/lib/versions/routes.js`
- Test: `interface-agent/test/confirmations.test.js`
- Test: `interface-agent/test/versions.test.js`

**Interfaces:**
- Produces: confirmation rejection for archived versions, atomic title/archive PATCH, and authenticated `/preview` alias.

- [ ] Add tests for archived confirmation rejection, no title mutation on archive conflict, and `/preview` HTML/CSP parity.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Add repository-level archived-version guard, prevalidate PATCH and transact writes, and share one preview handler across `/html` and `/preview`.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Deployment Backup and Contract Accuracy

**Files:**
- Modify: `interface-agent/DEPLOYMENT.md`
- Modify: `interface-agent/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-interface-agent-versioning-design.md`
- Modify: `docs/prompts/2026-07-10-interface-agent-versioning-claude-code.md`

**Interfaces:**
- Produces: fail-fast online SQLite backup command and explicit at-least-once processing contract.

- [ ] Replace the unavailable `sqlite3` CLI backup with `better-sqlite3#backup` writing into the mounted volume and verify a non-empty file before deployment continues.
- [ ] Document model-call and pipeline-notification crash windows, stable keys, and downstream/provider responsibilities.
- [ ] Verify shell examples, endpoint tables, and terminology are internally consistent.

### Task 4: Full Verification

**Files:**
- Verify all modified files.

- [ ] Run `npm test` in `interface-agent` and record the exact pass/fail count.
- [ ] Run `git diff --check` and inspect `git diff -- interface-agent docs/superpowers`.
- [ ] Confirm no `agent-pipeline` file changed and report any pre-existing failure separately.
