# Model each dialogue as one continuing application lineage

A dialogue session remains available after a generation task or deployment completes and owns exactly one application lineage. The dialogue can create multiple ordered generation tasks and application versions for that application; a request for a distinct application creates a new dialogue session, preventing task history, version baselines, and rollback targets from being mixed together.
