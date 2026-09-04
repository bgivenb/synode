import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EvidenceRequiredRule,
  HighRiskApprovalRule,
  IrreversibleActionRule,
  PolicyEngine,
  TenantBoundaryRule,
} from "../src/core/policy.js";
import type { JsonObject, PolicyContext, ToolDefinition } from "../src/core/types.js";

const tool: ToolDefinition = {
  description: "test",
  inputSchema: z.record(z.string(), z.json()) as z.ZodType<JsonObject>,
  name: "funds.release",
  reversible: false,
  risk: "high",
  async execute() {
    return {};
  },
};

function context(input: PolicyContext["call"]["input"]): PolicyContext {
  return {
    call: { id: "call", input, justification: "test", tool: tool.name },
    run: {
      context: { tenantId: "tenant-a" },
      definitionId: "workflow",
      nextStepIndex: 0,
      runId: "run",
      status: "running",
      version: "1",
    },
    tool,
  };
}

describe("policy engine", () => {
  const policy = new PolicyEngine([
    new TenantBoundaryRule(),
    new EvidenceRequiredRule(),
    new HighRiskApprovalRule(),
    new IrreversibleActionRule(),
  ]);

  it("gives denial precedence over approval", () => {
    const result = policy.evaluate(context({ evidenceIds: ["e-1"], tenantId: "tenant-b" }));
    expect(result.effect).toBe("deny");
    expect(result.decisions.map((decision) => decision.policyId)).toContain("tenant-boundary");
  });

  it("requires evidence for consequential calls", () => {
    const result = policy.evaluate(context({ tenantId: "tenant-a" }));
    expect(result.effect).toBe("deny");
    expect(result.decisions).toContainEqual(
      expect.objectContaining({ policyId: "evidence-required" }),
    );
  });

  it("requires approval for high-risk and irreversible calls", () => {
    const result = policy.evaluate(context({ evidenceIds: ["e-1"], tenantId: "tenant-a" }));
    expect(result.effect).toBe("require_approval");
    expect(
      result.decisions.filter((decision) => decision.effect === "require_approval"),
    ).toHaveLength(2);
  });

  it("allows low-risk reversible calls by default", () => {
    const safeContext = context({ tenantId: "tenant-a" });
    const safeTool = { ...tool, name: "knowledge.read", reversible: true, risk: "low" as const };
    expect(policy.evaluate({ ...safeContext, tool: safeTool }).effect).toBe("allow");
  });
});
