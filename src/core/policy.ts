import type {
  JsonValue,
  PolicyContext,
  PolicyDecision,
  PolicyEffect,
  PolicyRule,
} from "./types.js";

const PRECEDENCE: Record<PolicyEffect, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

export interface PolicyEvaluation {
  readonly decisions: readonly PolicyDecision[];
  readonly effect: PolicyEffect;
}

export class PolicyEngine {
  constructor(readonly rules: readonly PolicyRule[]) {}

  evaluate(context: PolicyContext): PolicyEvaluation {
    const decisions = this.rules.flatMap((rule) => {
      const decision = rule.evaluate(context);
      return decision ? [decision] : [];
    });
    const effect = decisions.reduce<PolicyEffect>(
      (current, decision) =>
        PRECEDENCE[decision.effect] > PRECEDENCE[current] ? decision.effect : current,
      "allow",
    );
    return { decisions, effect };
  }
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class TenantBoundaryRule implements PolicyRule {
  readonly id = "tenant-boundary";

  evaluate({ call, run }: PolicyContext): PolicyDecision | undefined {
    const runTenant = stringValue(run.context.tenantId);
    const callTenant = stringValue(call.input.tenantId);
    if (runTenant && callTenant && callTenant !== runTenant) {
      return {
        effect: "deny",
        policyId: this.id,
        reason: `Tool input tenant ${callTenant} does not match run tenant ${runTenant}`,
      };
    }
    return undefined;
  }
}

export class EvidenceRequiredRule implements PolicyRule {
  readonly id = "evidence-required";

  evaluate({ call, tool }: PolicyContext): PolicyDecision | undefined {
    if (tool.risk === "low") return undefined;
    const evidenceIds = call.input.evidenceIds;
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
      return {
        effect: "deny",
        policyId: this.id,
        reason: `${tool.name} requires at least one evidence identifier`,
      };
    }
    return undefined;
  }
}

export class HighRiskApprovalRule implements PolicyRule {
  readonly id = "high-risk-human-approval";

  evaluate({ tool }: PolicyContext): PolicyDecision | undefined {
    if (tool.risk !== "high") return undefined;
    return {
      effect: "require_approval",
      policyId: this.id,
      reason: `${tool.name} is high risk and requires an accountable human decision`,
    };
  }
}

export class IrreversibleActionRule implements PolicyRule {
  readonly id = "irreversible-action-checkpoint";

  evaluate({ tool }: PolicyContext): PolicyDecision | undefined {
    if (tool.reversible) return undefined;
    return {
      effect: "require_approval",
      policyId: this.id,
      reason: `${tool.name} cannot be automatically rolled back`,
    };
  }
}
