# Audit Package Guidance

- Depend at runtime only on `@ooopsstudio/core`; keep lifecycle optional and expose other observability through the narrow attachment API.
- Preserve immutable evidence, mandatory redaction, integrity-chain compatibility, bounded operations, idempotency reservations, and retryable finalization.
- Keep normal, transactional, and privileged admin capabilities separate. Never add runtime DDL, automatic retention, or production memory fallback.
- Treat PostgreSQL schema verification, transaction ownership, qualified identifiers, tombstones, and sealed partitions as security boundaries.
- Add adversarial, concurrency, packed-artifact, and live PostgreSQL tests for behavior changes.
