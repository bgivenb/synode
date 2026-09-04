# Operations guide

This guide defines candidate operating standards for a deployed Synode control plane. Values are design targets to validate during load, failure, and recovery testing—not measurements from the synthetic demo.

## Service objectives

| User journey | Candidate SLI | Initial target | Error-budget response |
| --- | --- | --- | --- |
| Accept a valid proposal durably | Successful event appends / valid append attempts | 99.9% monthly | Freeze feature rollout below 50% budget; reliability work only at exhaustion |
| Expose a pending approval | Time from policy decision to queryable approval | p99 < 2 s | Page if breached for 10 minutes |
| Dispatch an approved tool call | Age of oldest non-dead-letter outbox item | p99 < 30 s | Page on sustained breach; stop new low-priority runs |
| Reconstruct a completed run | Successful verified replays / replay attempts | 99.99% | Page immediately on integrity failure |
| Serve the operator API | Good responses / eligible requests | 99.9% monthly | Roll back if a release consumes 10% of budget in one hour |

Report latency distributions and error-budget burn, not averages alone. Exclude explicit policy denials and user-rejected approvals from availability; include unexpected validation, persistence, authorization, and dependency failures.

## Failure handling

1. A tool attempt is created through the same transaction as its durable workflow event.
2. A worker leases available work with `FOR UPDATE SKIP LOCKED`; lease expiry permits recovery after process loss.
3. Adapters must pass the persisted idempotency key to downstream systems where supported.
4. Retry only errors classified as transient. Backoff is exponential and bounded; exhausted calls move to a dead-letter state.
5. A dead-lettered high-risk call keeps the run incomplete and alerts an operator. It is never treated as success.
6. Re-drive requires a named operator, a reason, and re-evaluation of stale policy/evidence.

Backpressure should reject or defer low-priority intake before database connections, worker concurrency, or a downstream dependency saturates. Per-tenant concurrency and token/cost ceilings prevent one workload from monopolizing shared capacity.

## Release and rollback

- Build once, scan, sign, and deploy an immutable image digest.
- Apply backward-compatible expand migrations before application rollout; contract in a later release after old readers are gone.
- Deploy one canary task, exercise health and a synthetic workflow, then increase traffic in bounded stages.
- Automatic rollback triggers include health-check failure, elevated 5xx burn, append conflicts above baseline, replay failures, and dead-letter acceleration.
- Rollback application code independently of data. Never roll back an irreversible schema migration; forward-fix it.
- Archive evaluation reports, dependency inventory, image digest, migration set, approver, and deployment timestamps as release evidence.

## Incident response

| Severity | Example | Immediate action |
| --- | --- | --- |
| SEV-1 | Cross-tenant exposure, unauthorized tool execution, ledger integrity failure | Disable affected tools/intake, preserve evidence, engage security and service owner |
| SEV-2 | Approved calls cannot execute, widespread approval backlog, database failover failure | Stop rollout, shed low-priority work, restore capacity or dependency |
| SEV-3 | Single-tenant degradation, elevated retries with budget intact | Assign owner, mitigate during business hours, track recurrence |

The incident commander owns coordination; the service owner diagnoses; communications has a separate owner; the scribe preserves a timestamped decision log. A blameless review records contributing conditions, detection gaps, customer impact, follow-ups with owners/dates, and a test that prevents recurrence.

## Security operations

- Authenticate reviewer identity externally and authorize every read and decision; never accept identity from model output.
- Rotate secrets and KMS keys according to platform policy; prefer workload identity over static credentials.
- Export signed ledger checkpoints and retained evidence to an independently administered archive.
- Alert on RLS policy changes, privilege grants, disabled logging, WAF changes, rejected network flows, unusual approval velocity, and repeated idempotency conflicts.
- Redact prompts, retrieved content, tool payloads, and errors before logs. Audit evidence has a narrower audience and longer retention than application logs.

## Capacity and cost

Track cost per completed workflow, model tokens per step, retrieval fan-out, database connections, outbox age, worker saturation, and evidence-storage growth. Set account budgets and anomaly alerts. Require a measured quality gain before adopting a larger model, additional retrieval channel, or higher agent concurrency.

Quarterly game days should exercise dependency timeouts, worker termination during a lease, Aurora failover, stale approval expiry, corrupted replay input, tenant-scope attacks, and rollback under load. Recovery-time and recovery-point targets become commitments only after those tests support them.
