# Threat model

Synode’s central assumption is that model output, retrieved content, and tool responses are untrusted data. This document describes the reference implementation’s boundary; it is not a certification or a claim about a hosted production system.

## Protected assets

- tenant-scoped evidence and entity relationships;
- authority to invoke side-effecting tools;
- human approval identity, decision, and rationale;
- run state and idempotency records;
- event order, attribution, and audit integrity;
- policy configuration and tool schemas.

## Trust boundaries

1. **Proposal boundary:** an agent can propose a named tool call but cannot execute it.
2. **Validation boundary:** runtime schemas reject malformed or unexpected input before policy or execution.
3. **Policy boundary:** independent rules evaluate tenant, evidence, risk, and reversibility; denial has highest precedence.
4. **Approval boundary:** suspended calls resume only for the exact pending approval identifier.
5. **Adapter boundary:** tools receive the minimum validated input plus a run-scoped idempotency key.
6. **Audit boundary:** append operations require the expected stream sequence and link each event to the prior digest.

## Abuse cases and controls

| Abuse case | Current control | Production extension |
| --- | --- | --- |
| Prompt injection asks the agent to bypass policy | Agents have proposal authority only; the runtime owns policy and execution | Isolated model credentials, content provenance, adversarial evals |
| Cross-tenant identifier is placed in a call | Policy denies mismatched input; graph lookup is tenant-keyed; durable tables use forced RLS | Organization ABAC/RBAC and independent authorization review |
| Consequential action omits supporting evidence | Evidence rule denies medium/high-risk calls without evidence IDs | Evidence freshness, signature, lineage, and domain validation |
| Model attempts an irreversible action | High-risk and irreversible rules suspend the exact call for review | Authenticated reviewer groups, separation of duties, step-up auth |
| Network retry duplicates an external side effect | Canonical intent fingerprint, durable idempotency record, outbox lease, adapter key | Provider-side idempotency and reconciliation for each tool |
| Concurrent writers reorder an audit stream | Ledger append requires the expected sequence; PostgreSQL locks the run and advances it atomically | Load/failover evidence and bounded conflict retry |
| Historical event content is modified | SHA-256 chain verification fails | Signed checkpoints, immutable/WORM storage, external anchoring |
| A transient dependency fails | Bounded retry, leased outbox recovery, backoff, and dead-letter state | Per-adapter circuit breakers and measured retry budgets |
| Retrieved content contains hostile instructions | Retrieval returns data and provenance only; models cannot bypass tool policy | Content isolation, prompt-injection evals, source reputation controls |
| A stale approval is replayed after evidence changes | Approval is bound to one pending call identifier | Expiry and policy/evidence re-evaluation before resume |
| A compromised worker calls an arbitrary destination | AWS stack points workers at one private adapter endpoint; tools remain named and idempotent | Egress proxy, signed adapter identity, per-tool workload roles |

## Residual risks in the research implementation

- The default demo uses process-local stores; the PostgreSQL adapter is exercised in CI but not wired into the static demo.
- The demo reviewer identity is not authenticated.
- Hash chaining detects mutation when verified but does not prevent deletion or replacement by an administrator.
- Policies are examples and have not undergone domain, legal, security, or compliance review.
- The scripted agents and tools operate only on synthetic data.
- The static dashboard is an inspection surface, not an authorization surface.
- The AWS stack is synthesized and asserted, not evidence of a deployed or operated environment.

## Security reporting

Please use GitHub’s private vulnerability reporting for security issues. Do not include secrets, personal data, or live-system evidence in a public issue.
