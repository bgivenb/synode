import type { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RunStatus = "running" | "waiting_for_approval" | "completed" | "failed";
export type RiskLevel = "low" | "medium" | "high";
export type PolicyEffect = "allow" | "require_approval" | "deny";
export type Classification = "public" | "internal" | "restricted";

export interface EventDraft {
  readonly actor: string;
  readonly data: JsonObject;
  readonly type: string;
}

export interface LedgerEvent extends EventDraft {
  readonly eventId: string;
  readonly hash: string;
  readonly occurredAt: string;
  readonly previousHash: string | null;
  readonly runId: string;
  readonly sequence: number;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly call: ToolCall;
  readonly policyDecisions: readonly PolicyDecision[];
  readonly requestedAt: string;
  readonly stepId: string;
}

export interface ToolCall {
  readonly id: string;
  readonly input: JsonObject;
  readonly justification: string;
  readonly tool: string;
}

export interface AgentProposal {
  readonly actor: string;
  readonly summary: string;
  readonly calls: readonly ToolCall[];
}

export interface WorkflowStep {
  readonly id: string;
  readonly title: string;
  propose(context: Readonly<JsonObject>): Promise<AgentProposal>;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly steps: readonly WorkflowStep[];
}

export interface RunSnapshot {
  readonly context: Readonly<JsonObject>;
  readonly definitionId: string;
  readonly nextStepIndex: number;
  readonly pendingApproval?: ApprovalRequest;
  readonly runId: string;
  readonly status: RunStatus;
  readonly version: string;
}

export interface ToolExecutionContext {
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly runId: string;
}

export interface ToolDefinition<
  Input extends JsonObject = JsonObject,
  Output extends JsonObject = JsonObject,
> {
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly name: string;
  readonly reversible: boolean;
  readonly risk: RiskLevel;
  execute(input: Input, context: ToolExecutionContext): Promise<Output>;
}

export interface PolicyContext {
  readonly call: ToolCall;
  readonly run: RunSnapshot;
  readonly tool: ToolDefinition;
}

export interface PolicyDecision {
  readonly effect: PolicyEffect;
  readonly policyId: string;
  readonly reason: string;
}

export interface PolicyRule {
  readonly id: string;
  evaluate(context: PolicyContext): PolicyDecision | undefined;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly note: string;
  readonly reviewer: string;
}

export interface EngineResult {
  readonly events: readonly LedgerEvent[];
  readonly snapshot: RunSnapshot;
}
