# Interface Agent Review Fixes Design

## Scope

Only `interface-agent` is changed. `agent-pipeline` authentication, storage, and deployment are explicitly out of scope.

## Decisions

1. Independent-session recovery codes contain an opaque session locator plus the existing high-entropy edit token. Restore queries one active session and performs one scrypt verification; it never scans every active session.
2. Archived versions cannot become confirmed. Version metadata PATCH validates the complete request before any write and applies title/archive changes in one SQLite transaction.
3. The documented `/versions/:versionId/preview` endpoint is restored as an alias of `/html`; both use the same authenticated, sandboxed HTML handler.
4. SQLite deployment backup uses the installed `better-sqlite3` runtime to create an online backup inside the mounted persistent volume. Deployment stops if backup creation or verification fails.
5. Generation and delivery use recoverable at-least-once processing. A stable idempotency key and staged output prevent duplicates in covered crash windows, while strict exactly-once model calls or external notifications require provider/downstream support. The contract states this limitation instead of claiming an impossible single-service guarantee.

## Verification

- Regression tests cover one-hash recovery, archived confirmation rejection, atomic PATCH behavior, and `/preview` compatibility.
- Existing generation, delivery, session, share, and UI suites remain unchanged except where the clarified contract requires wording updates.
- Full `interface-agent` tests and `git diff --check` run before completion.
