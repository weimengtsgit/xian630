# Persist visible work traces and project them through scoped SSE

The factory will persist ordered, redacted, user-visible work-trace events before publishing them through per-dialogue SSE streams. The trace records recognized intent, proposed work, assumptions, clarification requests, tool and data-source summaries, validation, task state, deployment, and final output, but never hidden chain-of-thought; persistence enables history, sequence-based reconnect recovery, and correct concurrent-session isolation.
