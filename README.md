# Synode

[![CI](https://github.com/bgivenb/synode/actions/workflows/ci.yml/badge.svg)](https://github.com/bgivenb/synode/actions/workflows/ci.yml)
[![Live console](https://img.shields.io/badge/live-operations_console-67f5bc?labelColor=101512)](https://bgivenb.github.io/synode/)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL_17-pgvector-6adfe8?labelColor=101512)](db/README.md)
[![AWS CDK](https://img.shields.io/badge/AWS_CDK-asserted-ffbf69?labelColor=101512)](infra/README.md)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-d9e3de?labelColor=101512)](LICENSE)

Synode is a public research implementation of a governed execution runtime for consequential AI workflows. Agents can gather evidence, assess it, and propose actions; they cannot grant themselves authority. Typed contracts, deterministic policy, accountable human checkpoints, durable idempotency, tenant-scoped retrieval, and a tamper-evident event ledger control every side effect.

[**Open the operations console →**](https://bgivenb.github.io/synode/)

![Synode admin console showing a completed synthetic workflow, policy controls, a human checkpoint, and a verified audit ledger](docs/images/control-plane.png)

The checked-in scenario is deterministic and fully synthetic. Three specialized agents resolve a case, pause before an irreversible action, record a separately attributed approval, recover from an injected transient failure, and verify the resulting audit chain.

## Executable evidence

| Capability | Implementation | Verification |
| --- | --- | --- |
| Multi-agent workflow | Evidence, risk, and operations agents propose typed calls through one state machine | End-to-end scenario and replay assertions |
| Human-in-the-loop control | High-risk and irreversible calls enter a suspended approval state | Approval, rejection, wrong-ID, and fail-closed tests |
| Hybrid RAG + knowledge graph | Weighted reciprocal-rank fusion across full-text, vector, and recursive graph channels | Provenance/rank tests plus live PostgreSQL retrieval test |
| PostgreSQL depth | Forced RLS, composite tenant keys, pgvector HNSW, FTS, recursive CTEs, CAS event append, immutable events, outbox leases | CI boots PostgreSQL 17 + pgvector and exercises the migration as an unprivileged role |
| Reliable tool execution | Canonical intent fingerprints, idempotent replay, bounded retry, leases, ownership checks, dead letters | Property, fault-injection, executor, worker, and database tests |
| AWS architecture | Private ECS services, internal TLS/WAF ingress, Aurora Serverless v2 + RDS Proxy, KMS, retained evidence, autoscaling, alarms | CDK synthesis and CloudFormation assertions in every verification run |
| Delivery and operations | SLO/error-budget model, incident roles, migration strategy, staged adoption gates, ownership matrix, risk register | Versioned [operations guide](docs/OPERATIONS.md) and [delivery plan](docs/DELIVERY_PLAN.md) |

This repository makes architecture and engineering decisions inspectable through runnable code. It does not expose or reproduce any private-company system.

## Architecture

![Architecture: agents submit untrusted proposals to a Synode control plane that applies typed contracts, policy, approvals, idempotent execution, hybrid retrieval, and a hash-chained PostgreSQL ledger](docs/images/architecture.svg)

The trust boundary is deliberately narrow:

1. A model adapter may submit a proposal and justification.
2. The registry rejects unknown tools and schema-invalid input.
3. Independent policy rules evaluate the current call and run; `deny` outranks `require_approval`, which outranks `allow`.
4. A required approval suspends the exact call. Approval is never inferred from text or supplied by an agent.
5. The tool runtime executes with a canonical, run-scoped idempotency key and bounded retry policy.
6. Every transition is appended with actor, sequence, prior digest, and payload hash; replay verifies the chain before projecting state.

## Run it

Requires Node.js 22.12 or later.

```bash
git clone https://github.com/bgivenb/synode.git
cd synode
npm ci
npm run verify
npm run demo
npm run serve
```

Open `http://127.0.0.1:4173`. The demo writes its machine-readable evidence to `artifacts/demo-run.json`; the same deterministic report drives the static admin console.

Expected summary:

```text
Synode demo: completed
24 events · 1 approval · 1 recovered failure
2/2 evaluation scenarios passed · ledger verified
```

`npm run verify` performs formatting and lint checks, strict type checking, coverage enforcement, a production build, AWS CDK synthesis, and deterministic scenario verification.

## Agent and tool boundary

An agent receives proposal authority, not ambient credentials. Each call names a registered tool, passes a runtime schema, carries a justification, and is evaluated against tool risk metadata and current run context.

```ts
registry.register({
  name: "case.release",
  risk: "high",
  reversible: false,
  inputSchema: z.object({
    caseId: z.string(),
    tenantId: z.string(),
    evidenceIds: z.array(z.string()).min(1),
    reason: z.string().min(12),
  }),
  async execute(input, context) {
    return releaseHold(input, context.idempotencyKey);
  },
});
```

The example policy composes tenant, evidence, risk, and reversibility rules. Every matched decision and explanation is retained even when a higher-precedence rule wins.

## Hybrid retrieval and provenance

Synode scopes candidates before ranking. A record from another tenant or disallowed classification cannot affect visible ranks, scores, or graph traversal.

The TypeScript retriever merges provider-neutral keyword, vector, and graph backends with weighted reciprocal-rank fusion. Every result carries:

- the source URI and classification;
- the retrieval channels that contributed;
- its rank within each channel;
- a graph path when relational evidence contributed;
- a deterministic fused score.

The PostgreSQL function implements the same shape using `tsvector`, a pgvector cosine-distance index, a cycle-safe recursive graph CTE, and RRF. The repository intentionally does not bundle an embedding model; model choice is an evaluated adapter decision, and the schema rejects vectors with the wrong dimension.

## Durable PostgreSQL control plane

The in-memory adapters keep the demo fast. The executable [PostgreSQL migration](db/migrations/001_control_plane.sql) supplies the durable boundary:

- forced row-level security keyed by transaction-local tenant context;
- atomic compare-and-swap event append under a run-row lock;
- database-generated hash links and an event mutation trigger;
- consistent approval states and run-scoped idempotency records;
- transactional outbox leasing with `FOR UPDATE SKIP LOCKED`, ownership, backoff, and dead-letter state;
- tenant-keyed nodes, edges, chunks, full-text indexes, and pgvector HNSW indexes.

Run the live integration suite:

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/synode npm run test:postgres
docker compose down
```

CI uses an unprivileged application role to prove RLS behavior rather than testing as the database owner. See the [persistence notes](db/README.md).

## AWS reference deployment

`infra/synode-stack.ts` is executable CDK, not an architecture sketch. It synthesizes a two-AZ private topology with independent API/worker services, TLS/WAF ingress, Aurora PostgreSQL 17 Serverless v2, RDS Proxy, encryption boundaries, retained audit evidence, enhanced telemetry, autoscaling, and actionable alarms. Tests assert important CloudFormation properties so a refactor cannot silently make tasks public, remove TLS, disable database protection, or weaken evidence storage.

```bash
npm run infra:synth
docker build -f deploy/Dockerfile -t synode:0.1.0 .
```

The stack accepts immutable image, certificate, tenant-shard, and private tool-adapter parameters. Account-owned identity, DNS, log archive, budgets, and notification subscriptions remain explicit platform integration points. See the [AWS topology and deployment notes](infra/README.md).

## Reliability and evaluation

Runs are append-only streams:

```text
proposal.created
  → policy.evaluated
  → approval.requested
  → approval.decided
  → tool.attempt.started
  → tool.attempt.retryable_failure
  → tool.attempt.started
  → tool.completed
  → run.completed
```

The verification surface includes:

- **32 unit, property, scenario-component, worker, and infrastructure tests**;
- **4 live PostgreSQL integration tests** for migrations, RLS, event concurrency, immutability, leasing, and hybrid retrieval;
- **2 deterministic end-to-end evaluations** for approval/recovery and tenant isolation;
- at least **90% lines/functions/statements** and **85% branches** on the unit suite;
- locked dependencies and a high-severity production dependency audit in CI.

The [threat model](docs/THREAT_MODEL.md), [architecture decisions](docs/DECISIONS.md), [operations guide](docs/OPERATIONS.md), and [delivery plan](docs/DELIVERY_PLAN.md) make the residual risks, operating model, staged rollout, ownership, and stop conditions reviewable beside the code.

## Repository map

```text
src/core/         workflow engine, contracts, policy, ledger, graph, replay, evaluations
src/retrieval/    scoped hybrid retrieval and reciprocal-rank fusion
src/adapters/     durable PostgreSQL control-plane adapter
src/runtime/      leased outbox worker and HTTP tool dispatcher
src/demo/         synthetic multi-agent scenario and evidence generator
db/               PostgreSQL 17 + pgvector migration and integration guidance
infra/            AWS CDK stack and deployment contract
deploy/           non-root multi-stage application image
tests/            unit, property, infrastructure, worker, scenario, and database tests
docs/             admin console, runbooks, decisions, threat model, and generated evidence
.github/          CI, Pages deployment, ownership, and dependency automation
```

## Scope

The demo uses scripted agents, synthetic entities, and an injectable clock so its safety properties are reproducible. The repository reports test and scenario results only; it makes no claim about live traffic or deployment history. Before handling real consequential actions, a deployment must add organization-owned identity and authorization, independently reviewed domain policy, signed adapter trust, external immutable checkpoints, privacy/retention controls, load and recovery evidence, and a staffed operating model.

## License

Apache-2.0. See [LICENSE](LICENSE).
