---
status: accepted
---

# Interface Agent owns branching interface draft versions

The Interface Agent will own persistent, immutable, branching interface draft versions inside its own interface design sessions. It will use SQLite for session and version metadata, Blade OS for versioned HTML artifacts, and asynchronous generation records; it will not depend on Factory Server, because the two are currently independent services and Factory Server's dialogue and application versions describe a different domain.

Sharing, accepting, and delivering a draft are separate actions. A share link remains pinned to one version, acceptance moves the session's accepted-version reference with optimistic concurrency control, and downstream delivery is retryable without undoing acceptance. We rejected browser-only history because it cannot support durable or collaborative version switching, and rejected putting the data in Factory Server because that would introduce a new cross-service ownership dependency solely for this feature.

Consequences: Interface Agent needs a persistent SQLite volume, authenticated edit-session access, versioned Blade OS paths, background generation and delivery processing, and one-time migration of legacy browser state. System version numbers are immutable display labels; identity and ancestry always use opaque version IDs and parent-version IDs.
