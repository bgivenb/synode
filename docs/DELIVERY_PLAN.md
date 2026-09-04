# Delivery and adoption plan

This plan shows how the research runtime could be introduced into an existing engineering organization without a rewrite or an unbounded “AI transformation” program. It defines decision gates and ownership; it does not claim that the public demo has completed these phases.

## Principles

- Start with one bounded, reversible workflow whose baseline is already measured.
- Keep deterministic policy, identity, and side effects outside the model boundary.
- Prefer integration seams over platform replacement.
- Ship observable increments behind tenant-scoped flags and explicit kill switches.
- Measure task quality, operational safety, adoption, latency, and total cost together.

## Phases and gates

| Phase | Deliverable | Exit evidence | Stop condition |
| --- | --- | --- | --- |
| 0. Baseline | Current-state journey, failure modes, cost/latency/quality baseline, data classification | Named owner, measurable problem, approved threat model | No consequential problem or no accountable owner |
| 1. Shadow | Agent proposals recorded but never executed | Offline eval threshold met; no tenant leakage; cost envelope understood | Quality cannot beat a simple deterministic baseline |
| 2. Assisted | Reviewer sees recommendation, sources, policy result, and proposed call | Reviewer agreement, override reasons, accessibility/usability review | Automation bias or evidence provenance is unacceptable |
| 3. Guarded action | Low-risk reversible tools execute; high-risk tools remain approval-gated | Error budget, red-team suite, rollback and incident game day pass | Unauthorized action or unstable idempotency behavior |
| 4. Scale | Additional tenants/workflows through a paved-road onboarding process | Capacity model, ownership, support rotation, quarterly control review | Marginal workflow value does not justify complexity or cost |

Each gate is a documented go/no-go decision. A deadline does not waive a failed safety, reliability, or evidence criterion.

## Ownership model

| Decision or artifact | Accountable | Responsible | Consulted |
| --- | --- | --- | --- |
| Workflow outcome and policy semantics | Domain product owner | Workflow team | Legal/compliance, support, security |
| Control-plane runtime and paved road | Platform engineering lead | Platform team | Workflow teams, SRE |
| Production readiness and SLO | Service owner | Delivery team | SRE, security |
| Model/retrieval evaluation | Applied AI lead | Evaluation owner | Domain experts, data governance |
| High-risk release approval | Change owner | Release engineer | Service owner, security as required |
| Incident command | On-call incident commander | Responding engineers | Product, support, security, communications |

Names belong in the organization’s service catalog and on-call system. Repository ownership and `CODEOWNERS` are supporting controls, not substitutes for accountable operators.

## Engineering operating cadence

- A short written RFC establishes the problem, alternatives, trust boundaries, quality baseline, capacity model, and exit criteria before implementation.
- Weekly delivery review covers outcome movement, risks, decisions needed, reliability budget, and dependencies—not ticket counts.
- Architecture decisions are committed beside code. Material reversals create a new ADR rather than silently rewriting history.
- Pull requests require an evaluation delta and rollout/rollback note for policy, retrieval, tool, or schema changes.
- Monthly operating review examines SLOs, incidents, dead letters, overrides, cost per workflow, model/vendor concentration, and roadmap tradeoffs.
- Quarterly control review revalidates reviewer permissions, retention, threat model, model cards, and kill switches.

## Build, buy, and partner boundaries

Build the authorization and evidence layer when its semantics are differentiating and must remain inspectable. Adopt commodity identity, secrets, observability, database, queueing, and model gateways where mature internal or managed services exist. Keep model and vector providers behind narrow adapters so a vendor change does not rewrite workflow state, policy, or audit history.

Reject a custom platform if a thin composition of existing workflow, policy, and observability systems meets the controls. Reject an agent approach when deterministic software achieves the required outcome more safely or cheaply.

## Risk register

| Risk | Leading signal | Mitigation | Owner role |
| --- | --- | --- | --- |
| Automation bias | Falling override rate without quality gain | Blind review samples; require evidence inspection for high-risk actions | Product + Applied AI |
| Cross-tenant retrieval | Scope-test or RLS failure | Fail closed; security incident; independent tenant-boundary tests | Platform + Security |
| Duplicate side effect | Idempotency conflict or downstream duplicate | Canonical intent fingerprint, provider key, reconciliation | Workflow team |
| Approval bottleneck | Oldest approval age and abandonment rise | Routing, expiry, staffing model; do not bypass gate | Product operations |
| Vendor/model regression | Evaluation delta or cost/latency shift | Version pin, shadow comparison, fast rollback | Applied AI |
| Platform overreach | Onboarding lead time and exception count rise | Smaller paved road, explicit extension points, retire unused abstractions | Platform lead |
| Hidden operating cost | Cost per completed workflow rises | Per-tenant budgets, caching, model routing, complexity kill criteria | Service owner |

## Definition of done for a workflow

A workflow is ready for guarded production only when its owner, SLO, threat model, data classification, policy set, tool contracts, evaluation dataset, tenant tests, approval UX, reconciliation path, dashboards, alerts, runbook, on-call routing, rollback, cost envelope, and decommission plan are all reviewed and exercised. “The model produced a good demo” is not an exit criterion.
