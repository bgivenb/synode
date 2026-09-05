# Synode: technical walkthrough

A five-minute walkthrough of a portfolio project by Given Borthwick, developed with AI coding assistance. It makes the implementation, decisions, and verification inspectable without exposing private-company code.

Synode reflects patterns and engineering concerns from my professional work on production systems. It demonstrates my approach to architecture, controlled automation, reliability, and verification through an independent implementation using synthetic data—not company code or a copy of a deployed system.

## 1. What the project explores

Synode explores a specific question: how can agents propose useful work without becoming the authority that permits it?

The example is a synthetic operational hold review. Three scripted agents gather evidence, assess it, and propose releasing a hold. The runtime applies policy, pauses for a separately attributed approval, executes the tool, and records the outcome. The [console](https://bgivenb.github.io/synode/) displays that recorded scenario; it is not a live production administration service.

Start with [the workflow definition](../src/demo/scenario.ts), then follow its calls into [the engine](../src/core/engine.ts).

## 2. A difficult decision: approval belongs to execution state

The important boundary is not whether an agent can produce a plausible justification. It is whether that justification can authorize a side effect.

Synode keeps these separate. Policy can deny a call or require approval. An approval suspends a specific pending call; resuming requires its approval identifier and a separately attributed decision. The alternative—accepting an agent-provided approval flag—would put authorization inside the untrusted proposal.

This introduces explicit state transitions and a pending-work lifecycle, but makes rejection and invalid transitions testable. [Engine tests](../tests/engine.test.ts) exercise approval, rejection, a wrong approval identifier, and tenant-policy denial. Reviewer authentication is an integration requirement, not something the demo's reviewer string proves.

## 3. A failure: the approved action fails on its first attempt

The scenario deliberately injects a transient failure into `case.release`, before it returns a result. Approval alone is therefore insufficient to complete the workflow. The executor classifies the failure as retryable, records it, and retries within an attempt limit.

The interesting follow-up is replay: a completed call with the same run-scoped key and canonical input returns its recorded result; reusing that key with different input fails. [Tool tests](../tests/tools.test.ts) check invocation counts, retry limits, and conflicting key reuse. [The scenario test](../tests/demo.test.ts) checks one approval, one recovered failure, and a valid ledger.

This is an exercised failure case, not a claimed customer incident. It also does not prove exactly-once external effects: a downstream action could succeed before its response is lost. A real adapter needs downstream idempotency or reconciliation. The [durable outbox design](DECISIONS.md#adr-009-separate-durable-intent-from-distributed-execution) makes that boundary explicit.

## 4. A tradeoff: reproducibility before model variability

The public demo uses scripted proposals and in-memory execution so it runs without credentials and produces repeatable evidence. That makes policy and recovery regressions easier to isolate, but does not measure a model's reasoning or retrieval quality on real tasks.

The repository also contains a PostgreSQL adapter, migration, worker, and AWS CDK stack. Those components have separate tests; the browser demo does not establish an end-to-end deployed PostgreSQL/AWS service. A next increment would connect a real model and durable execution path, then measure quality, cost, latency, and recovery rather than infer them from the deterministic demo.

## 5. AI assistance and verification

AI coding agents assisted with implementation, tests, documentation, and verification runs. This is AI-assisted portfolio work, not a claim of unaided authorship or an independent security audit.

The checks are reproducible:

```bash
npm ci
npm run verify
npm run demo
```

`verify` runs formatting, lint, types, coverage-enforced tests, compilation, CDK synthesis, and scenario verification. [CI](../.github/workflows/ci.yml) separately runs [PostgreSQL integration tests](../tests/postgres.integration.ts) against a real database, including checks using an unprivileged application role, and audits production dependencies.

Generated tests can share generated code's blind spots. These checks provide evidence for specific assertions—not blanket production readiness. Independent review, live-model evaluations, load tests, and deployment recovery exercises remain useful next steps.

## Closing summary

Synode is an example of engineering work: explicit authority boundaries, inspectable failure handling, and testable infrastructure. Its value is in the code and decisions available for discussion, not an implied deployment history.
