import { z } from "zod";
import { FailurePlan } from "../core/chaos.js";
import { WorkflowEngine } from "../core/engine.js";
import { type EvaluationReport, evaluate } from "../core/evaluation.js";
import { KnowledgeGraph } from "../core/graph.js";
import { InMemoryEventLedger } from "../core/ledger.js";
import {
  EvidenceRequiredRule,
  HighRiskApprovalRule,
  IrreversibleActionRule,
  PolicyEngine,
  TenantBoundaryRule,
} from "../core/policy.js";
import { replay } from "../core/replay.js";
import { ToolExecutor, ToolRegistry } from "../core/tools.js";
import type { EngineResult, JsonObject, LedgerEvent, WorkflowDefinition } from "../core/types.js";

const TENANT_ID = "northstar-demo";
const RUN_ID = "run-synthetic-0142";

function deterministicIds(): () => string {
  let sequence = 0;
  return () => `evt-${String(++sequence).padStart(4, "0")}`;
}

function buildGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph();
  graph.addNode({
    attributes: { status: "review", subject: "Synthetic account 0142" },
    classification: "internal",
    id: "case-0142",
    kind: "case",
    tenantId: TENANT_ID,
  });
  graph.addNode({
    attributes: { country: "US", name: "Demo Company LLC" },
    classification: "restricted",
    id: "party-0901",
    kind: "organization",
    tenantId: TENANT_ID,
  });
  graph.addNode({
    attributes: { finding: "Ownership document verified", source: "document-service" },
    classification: "restricted",
    id: "evidence-doc-0088",
    kind: "evidence",
    tenantId: TENANT_ID,
  });
  graph.addNode({
    attributes: { finding: "Account signal stable", source: "transaction-monitor" },
    classification: "restricted",
    id: "evidence-signal-0021",
    kind: "evidence",
    tenantId: TENANT_ID,
  });
  graph.addNode({
    attributes: { name: "Unrelated tenant record" },
    classification: "restricted",
    id: "never-leak",
    kind: "case",
    tenantId: "other-tenant",
  });
  graph.addEdge({
    from: "case-0142",
    id: "edge-case-party",
    relation: "concerns",
    tenantId: TENANT_ID,
    to: "party-0901",
  });
  graph.addEdge({
    from: "case-0142",
    id: "edge-case-document",
    relation: "supported_by",
    tenantId: TENANT_ID,
    to: "evidence-doc-0088",
  });
  graph.addEdge({
    from: "case-0142",
    id: "edge-case-signal",
    relation: "supported_by",
    tenantId: TENANT_ID,
    to: "evidence-signal-0021",
  });
  return graph;
}

function createRuntime(failurePlan = new FailurePlan().failNext("case.release", 1)): {
  readonly engine: WorkflowEngine;
  readonly graph: KnowledgeGraph;
  readonly ledger: InMemoryEventLedger;
} {
  const graph = buildGraph();
  const ledgerIds = deterministicIds();
  let tick = 0;
  const ledger = new InMemoryEventLedger({
    clock: () => new Date(Date.UTC(2026, 8, 4, 17, 0, tick++)),
    idFactory: ledgerIds,
  });
  const registry = new ToolRegistry();

  const retrieveSchema = z.object({
    anchorIds: z.array(z.string()).min(1),
    query: z.string().min(1),
    tenantId: z.string().min(1),
  });
  registry.register({
    description: "Retrieve tenant-scoped evidence with path provenance",
    inputSchema: retrieveSchema,
    name: "knowledge.retrieve",
    reversible: true,
    risk: "low",
    async execute(input) {
      const hits = graph.retrieve({
        allowedClassifications: new Set(["public", "internal", "restricted"]),
        anchorIds: input.anchorIds,
        maxDepth: 2,
        query: input.query,
        tenantId: input.tenantId,
      });
      return {
        evidenceIds: hits.filter((hit) => hit.node.kind === "evidence").map((hit) => hit.node.id),
        hitCount: hits.length,
        provenancePaths: hits.map((hit) => [...hit.path]),
      };
    },
  });

  const assessSchema = z.object({
    evidenceIds: z.array(z.string()).min(1),
    tenantId: z.string().min(1),
  });
  registry.register({
    description: "Produce a deterministic synthetic risk assessment",
    inputSchema: assessSchema,
    name: "risk.assess",
    reversible: true,
    risk: "medium",
    async execute(input) {
      const score = Math.max(0, 40 - input.evidenceIds.length * 8);
      return {
        band: score < 30 ? "low" : "review",
        evidenceCount: input.evidenceIds.length,
        score,
      };
    },
  });

  const releaseSchema = z.object({
    caseId: z.string().min(1),
    evidenceIds: z.array(z.string()).min(1),
    reason: z.string().min(12),
    tenantId: z.string().min(1),
  });
  registry.register({
    description: "Release a synthetic operational hold",
    inputSchema: releaseSchema,
    name: "case.release",
    reversible: false,
    risk: "high",
    async execute(input, context) {
      failurePlan.checkpoint("case.release");
      return {
        caseId: input.caseId,
        idempotencyKey: context.idempotencyKey,
        released: true,
        tenantId: input.tenantId,
      };
    },
  });

  const policy = new PolicyEngine([
    new TenantBoundaryRule(),
    new EvidenceRequiredRule(),
    new HighRiskApprovalRule(),
    new IrreversibleActionRule(),
  ]);
  const executor = new ToolExecutor(registry);
  const approvalIds = (() => {
    let sequence = 0;
    return () => `approval-${String(++sequence).padStart(3, "0")}`;
  })();
  const engine = new WorkflowEngine(ledger, registry, executor, policy, {
    idFactory: approvalIds,
    wait: async () => undefined,
  });
  return { engine, graph, ledger };
}

function workflow(): WorkflowDefinition {
  return {
    id: "synthetic-hold-review",
    name: "Synthetic operational hold review",
    steps: [
      {
        id: "gather-evidence",
        title: "Gather tenant-scoped evidence",
        async propose() {
          return {
            actor: "evidence-agent",
            calls: [
              {
                id: "retrieve-case-context",
                input: {
                  anchorIds: ["case-0142"],
                  query: "verified account signal evidence",
                  tenantId: TENANT_ID,
                },
                justification: "Resolve the case and its supporting evidence with provenance",
                tool: "knowledge.retrieve",
              },
            ],
            summary: "Retrieve the minimum tenant-scoped context needed for assessment",
          };
        },
      },
      {
        id: "assess-risk",
        title: "Assess evidence",
        async propose() {
          return {
            actor: "risk-agent",
            calls: [
              {
                id: "assess-case-risk",
                input: {
                  evidenceIds: ["evidence-doc-0088", "evidence-signal-0021"],
                  tenantId: TENANT_ID,
                },
                justification: "Calculate a reproducible risk band from the approved evidence set",
                tool: "risk.assess",
              },
            ],
            summary: "Produce a deterministic recommendation from verified evidence",
          };
        },
      },
      {
        id: "propose-action",
        title: "Propose consequential action",
        async propose() {
          return {
            actor: "operations-agent",
            calls: [
              {
                id: "release-case-hold",
                input: {
                  caseId: "case-0142",
                  evidenceIds: ["evidence-doc-0088", "evidence-signal-0021"],
                  reason: "Verified evidence supports releasing the synthetic hold",
                  tenantId: TENANT_ID,
                },
                justification: "Advance the case only after an accountable human checkpoint",
                tool: "case.release",
              },
            ],
            summary: "Propose releasing the hold while preserving human accountability",
          };
        },
      },
    ],
    version: "1.0.0",
  };
}

export interface DemoReport {
  readonly controls: readonly { readonly name: string; readonly result: string }[];
  readonly evaluation: EvaluationReport;
  readonly events: readonly LedgerEvent[];
  readonly graph: ReturnType<KnowledgeGraph["export"]>;
  readonly meta: {
    readonly generatedAt: string;
    readonly note: string;
    readonly scenario: string;
    readonly synthetic: true;
  };
  readonly metrics: JsonObject;
  readonly run: EngineResult["snapshot"];
}

async function runHappyPath(): Promise<{
  readonly final: EngineResult;
  readonly graph: KnowledgeGraph;
  readonly ledger: InMemoryEventLedger;
}> {
  const { engine, graph, ledger } = createRuntime();
  const paused = await engine.start(
    workflow(),
    { caseId: "case-0142", tenantId: TENANT_ID },
    RUN_ID,
  );
  if (!paused.snapshot.pendingApproval) throw new Error("Demo did not reach its approval gate");
  const final = await engine.decide(RUN_ID, paused.snapshot.pendingApproval.approvalId, {
    approved: true,
    note: "Synthetic evidence and policy checks reviewed",
    reviewer: "demo-operator",
  });
  return { final, graph, ledger };
}

export async function createDemoReport(): Promise<DemoReport> {
  const { final, graph, ledger } = await runHappyPath();
  const projection = replay(final.events);
  const evaluation = await evaluate([
    {
      id: "approval-and-recovery",
      name: "High-risk action pauses, receives approval, and survives a transient failure",
      async run() {
        return [
          { actual: projection.status, expected: "completed", label: "final status" },
          { actual: projection.approvals, expected: 1, label: "human approvals" },
          { actual: projection.retries, expected: 1, label: "retryable failures" },
          { actual: ledger.verify(RUN_ID), expected: true, label: "ledger integrity" },
        ];
      },
    },
    {
      id: "tenant-isolation",
      name: "Graph retrieval never crosses tenant boundaries",
      async run() {
        const hits = graph.retrieve({
          allowedClassifications: new Set(["public", "internal", "restricted"]),
          anchorIds: ["case-0142"],
          maxDepth: 4,
          tenantId: TENANT_ID,
        });
        return [
          {
            actual: hits.some((hit) => hit.node.id === "never-leak"),
            expected: false,
            label: "cross-tenant records returned",
          },
        ];
      },
    },
  ]);

  return {
    controls: [
      { name: "Typed inputs", result: "Zod-validated before every tool invocation" },
      { name: "Tenant boundary", result: "Enforced in policy and retrieval layers" },
      { name: "Human checkpoint", result: "Required for high-risk and irreversible actions" },
      { name: "Idempotency", result: "Run-scoped keys prevent duplicate side effects" },
      { name: "Recovery", result: "Transient failure retried with deterministic backoff" },
      { name: "Audit integrity", result: "SHA-256 event chain verified before projection" },
    ],
    evaluation,
    events: final.events,
    graph: graph.export(TENANT_ID, new Set(["public", "internal", "restricted"])),
    meta: {
      generatedAt: "2026-09-04T17:01:00.000Z",
      note: "All organizations, people, case identifiers, and outcomes are synthetic.",
      scenario: "Synthetic operational hold review",
      synthetic: true,
    },
    metrics: {
      approvals: projection.approvals,
      events: final.events.length,
      ledgerValid: ledger.verify(RUN_ID),
      retries: projection.retries,
      toolAttempts: projection.toolAttempts,
      toolsCompleted: Object.keys(projection.results).length,
    },
    run: final.snapshot,
  };
}
