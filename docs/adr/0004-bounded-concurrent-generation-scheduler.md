# Run generation with global bounded concurrency and per-application serialization

The factory will run generation tasks with a configurable global worker limit of three, rather than the current process-wide single-task lock. Tasks for different applications may run concurrently, while tasks modifying the same application are serialized against their version baseline; this preserves throughput for independent meetings without creating conflicting application revisions.
