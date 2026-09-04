# PostgreSQL persistence

`migrations/001_control_plane.sql` is an executable PostgreSQL 17 + pgvector reference schema. It is exercised against a real database in CI rather than validated as inert SQL text.

## Data guarantees

- Composite tenant keys and forced row-level security establish defense in depth below application predicates.
- `append_run_event` locks the run row and performs a compare-and-swap append, hash creation, and sequence advance in one transaction.
- The event table rejects updates and deletes. External immutable checkpoints remain necessary to detect privileged replacement or truncation.
- Approval records enforce consistent pending/decided attribution states.
- Idempotency records bind a run-scoped key to one intent fingerprint and result lifecycle.
- Tool calls use a transactional outbox. Workers claim batches with `FOR UPDATE SKIP LOCKED`, bounded leases, exponential retry delay, and a dead-letter state.
- Knowledge chunks support PostgreSQL full-text search, pgvector HNSW search, and recursive graph traversal. Reciprocal-rank fusion returns channels, ranks, source URIs, and graph paths.

## Run the integration suite

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/synode npm run test:postgres
docker compose down
```

The suite creates an unprivileged application role and verifies forced RLS, tenant isolation, append conflicts, event immutability, outbox lease ownership, idempotent enqueueing, and hybrid retrieval. The Compose database is disposable and stores data on a temporary filesystem.

The 384-dimension vector column is a concrete reference choice, not a requirement of the core runtime. Changing the embedding model requires a versioned migration, re-embedding plan, and retrieval evaluation before rollout.
