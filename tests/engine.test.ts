import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowEngine } from "../src/core/engine.js";
import { InvalidTransitionError } from "../src/core/errors.js";
import { InMemoryEventLedger } from "../src/core/ledger.js";
import { HighRiskApprovalRule, PolicyEngine, TenantBoundaryRule } from "../src/core/policy.js";
import { replay } from "../src/core/replay.js";
import { ToolExecutor, ToolRegistry } from "../src/core/tools.js";
import type { WorkflowDefinition } from "../src/core/types.js";

function runtime(): { engine: WorkflowEngine; workflow: WorkflowDefinition } {
  const ledger = new InMemoryEventLedger();
  const registry = new ToolRegistry();
  registry.register({
    description: "record action",
    inputSchema: z.object({
      evidenceIds: z.array(z.string()),
      tenantId: z.string(),
      value: z.number(),
    }),
    name: "action.record",
    reversible: true,
    risk: "high",
    async execute(input) {
      return { accepted: true, value: input.value };
    },
  });
  let approval = 0;
  const engine = new WorkflowEngine(
    ledger,
    registry,
    new ToolExecutor(registry),
    new PolicyEngine([new TenantBoundaryRule(), new HighRiskApprovalRule()]),
    { idFactory: () => `approval-${++approval}` },
  );
  const workflow: WorkflowDefinition = {
    id: "test-flow",
    name: "Test flow",
    steps: [
      {
        id: "act",
        title: "Act",
        async propose() {
          return {
            actor: "agent",
            calls: [
              {
                id: "call-1",
                input: { evidenceIds: ["e-1"], tenantId: "a", value: 7 },
                justification: "test",
                tool: "action.record",
              },
            ],
            summary: "propose action",
          };
        },
      },
    ],
    version: "1",
  };
  return { engine, workflow };
}

describe("workflow engine", () => {
  it("pauses, records human approval, executes, and replays deterministically", async () => {
    const { engine, workflow } = runtime();
    const paused = await engine.start(workflow, { tenantId: "a" }, "run-1");
    expect(paused.snapshot.status).toBe("waiting_for_approval");
    expect(paused.snapshot.pendingApproval?.call.id).toBe("call-1");

    const final = await engine.decide("run-1", "approval-1", {
      approved: true,
      note: "reviewed",
      reviewer: "operator",
    });
    expect(final.snapshot.status).toBe("completed");
    expect(final.snapshot.context.results).toEqual({ "call-1": { accepted: true, value: 7 } });
    expect(replay(final.events)).toEqual(
      expect.objectContaining({ approvals: 1, status: "completed", toolAttempts: 1 }),
    );
    expect(engine.snapshot("run-1").status).toBe("completed");
  });

  it("fails closed when a reviewer rejects the action", async () => {
    const { engine, workflow } = runtime();
    await engine.start(workflow, { tenantId: "a" }, "run-rejected");
    const result = await engine.decide("run-rejected", "approval-1", {
      approved: false,
      note: "insufficient evidence",
      reviewer: "operator",
    });
    expect(result.snapshot.status).toBe("failed");
    expect(result.events.at(-1)?.type).toBe("run.failed");
  });

  it("fails closed on a tenant-policy denial", async () => {
    const { engine, workflow } = runtime();
    const originalStep = workflow.steps[0];
    if (!originalStep) throw new Error("Expected one workflow step");
    const denied: WorkflowDefinition = {
      ...workflow,
      steps: [
        {
          ...originalStep,
          async propose() {
            return {
              actor: "agent",
              calls: [
                {
                  id: "cross-tenant",
                  input: { evidenceIds: ["e"], tenantId: "b", value: 1 },
                  justification: "test",
                  tool: "action.record",
                },
              ],
              summary: "invalid",
            };
          },
        },
      ],
    };
    const result = await engine.start(denied, { tenantId: "a" }, "run-denied");
    expect(result.snapshot.status).toBe("failed");
    expect(replay(result.events).deniedCalls).toBe(1);
  });

  it("rejects invalid state transitions", async () => {
    const { engine, workflow } = runtime();
    await expect(
      engine.decide("missing", "none", { approved: true, note: "", reviewer: "x" }),
    ).rejects.toThrow(InvalidTransitionError);
    await engine.start(workflow, { tenantId: "a" }, "run-1");
    await expect(engine.start(workflow, { tenantId: "a" }, "run-1")).rejects.toThrow(
      "already exists",
    );
    await expect(
      engine.decide("run-1", "wrong", { approved: true, note: "", reviewer: "x" }),
    ).rejects.toThrow("not pending");
  });
});
