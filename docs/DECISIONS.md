# Architecture decisions

## ADR-001: Models propose; deterministic code authorizes and executes

**Status:** accepted

Model adapters are intentionally outside the execution trust boundary. They can propose typed calls and explain their rationale, but only the runtime can validate, authorize, suspend, or execute those calls.

This prevents an instruction in model or retrieved content from granting itself authority. It also keeps policy behavior testable without a model provider.

## ADR-002: Use an append-only event stream as the system of record

**Status:** accepted for the reference design

Every state transition produces an event. Optimistic sequence checks reject stale concurrent writes, and each event commits the previous digest into a hash chain. State can therefore be reconstructed and evaluation failures can point to the exact transition that violated an expectation.

The in-memory adapter demonstrates the contract. A production implementation should append the event and any transactional outbox record atomically in a durable store.

## ADR-003: Make human approval a suspended execution state

**Status:** accepted

Approval is not a boolean parameter supplied by an agent and is not inferred from text. The runtime stores the exact pending call, exposes an approval identifier, and resumes only after a separately attributed decision for that identifier.

Production implementations should authenticate reviewers, enforce separation of duties, and re-evaluate stale evidence or policy before resuming long-lived approvals.

## ADR-004: Scope retrieval before ranking

**Status:** accepted

Tenant and classification filters are applied before graph traversal results are scored or exported. This avoids using ranking as an access-control mechanism and prevents inaccessible nodes from influencing visible results.

## ADR-005: Couple idempotency keys to canonical intent

**Status:** accepted

An idempotency record stores both the result and a SHA-256 fingerprint of the tool name plus canonical input. A repeated key returns the prior result only when the intent is identical; conflicting reuse fails visibly.

## ADR-006: Keep the public demo deterministic and provider-neutral

**Status:** accepted

The example uses scripted agents, an injectable clock and ID source, synthetic entities, and an injected failure plan. This makes safety properties reproducible in CI and avoids implying that a probabilistic model response is a verified product outcome.

Real model adapters belong at the proposal boundary and should be evaluated independently for task quality, adversarial robustness, calibration, cost, and latency.

## ADR-007: Use PostgreSQL as both durable ledger boundary and knowledge substrate

**Status:** accepted for the reference deployment

Workflow state, approvals, idempotency, outbox leases, graph relations, searchable chunks, and embeddings share one transactional boundary. PostgreSQL row locks make event compare-and-swap and outbox claims explicit; forced row-level security adds defense below application predicates. Full-text, pgvector, and recursive graph retrieval can be fused without copying authorization metadata into three services.

This favors correctness and operating simplicity over independently scaling each storage mode. Split services become justified only after measured workload or ownership boundaries outweigh cross-system consistency and authorization costs.

## ADR-008: Fuse retrieval channels after authorization scope

**Status:** accepted

Keyword, vector, and graph channels each provide useful but different signals. Weighted reciprocal-rank fusion avoids pretending their raw scores are calibrated on one scale, remains deterministic, and exposes each contributing rank. Tenant and classification filtering occurs before ranks are assigned so inaccessible candidates cannot influence visible results.

Embedding dimension and channel weights are versioned configuration. Changes require retrieval evaluations and a re-embedding or dual-read rollout plan.

## ADR-009: Separate durable intent from distributed execution

**Status:** accepted

A transaction writes workflow state and a tool outbox record. Workers claim rows with bounded leases and `FOR UPDATE SKIP LOCKED`, then call a private adapter with the persisted idempotency key. Acknowledged work completes; transient failures back off; exhausted work dead-letters. This favors at-least-once delivery with exactly-once intent over an unprovable exactly-once network claim.

## ADR-010: Keep account ownership outside the reusable AWS stack

**Status:** accepted

The CDK stack owns private compute, database, encryption, retained evidence, ingress controls, telemetry, and alarms. It accepts an immutable image, certificate, tenant shard, and private tool endpoint. Identity provider, DNS, central log archive, budgets, and notification subscribers stay in the organization’s platform layer, where lifecycle and authority actually belong.

CloudFormation assertions protect key availability and security properties. Synthesis demonstrates configuration integrity, not a claim that this repository operates a live AWS environment.
