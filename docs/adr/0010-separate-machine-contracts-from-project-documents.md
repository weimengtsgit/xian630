# Separate machine contracts from project documents

Generation steps will keep `output.json` and similar structured outputs as immutable machine execution contracts, while exposing user-readable Markdown project documents as projections linked back to those contracts. User edits to Markdown documents do not overwrite historical contracts or directly drive later task execution; they must first be converted into a confirmed structured change before a new generation task uses them.

Document edits are persisted as separate document drafts keyed by application, document path, source document checksum, and dialogue lineage. A draft can be saved for review without changing the effective application version; applying it starts a conversion flow that turns the draft delta into a structured application-modification proposal in the central conversation, where the user confirms or rejects it before a generation task is created.

If the source document or application version changes while a draft is open, the draft is marked stale and must be rebased or discarded before conversion. Conversion failures leave the draft intact and surface an ordinary dialogue error/clarification rather than mutating any machine contract.
