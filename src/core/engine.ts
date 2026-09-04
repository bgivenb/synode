import { randomUUID } from "node:crypto";
import { InvalidTransitionError } from "./errors.js";
import type { EventLedger } from "./ledger.js";
import type { PolicyEngine } from "./policy.js";
import type { ToolAttempt, ToolExecutor, ToolRegistry } from "./tools.js";
import type {
  AgentProposal,
  ApprovalDecision,
  ApprovalRequest,
  EngineResult,
  JsonObject,
  JsonValue,
  RunSnapshot,
  RunStatus,
  WorkflowDefinition,
} from "./types.js";

interface MutableRun {
  callCursor: number;
  context: JsonObject;
  definition: WorkflowDefinition;
  nextStepIndex: number;
  pendingApproval?: ApprovalRequest;
  proposal?: AgentProposal;
  runId: string;
  status: RunStatus;
}

interface EngineOptions {
  readonly idFactory?: () => string;
  readonly maxToolAttempts?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export class WorkflowEngine {
  readonly #executor: ToolExecutor;
  readonly #idFactory: () => string;
  readonly #ledger: EventLedger;
  readonly #maxToolAttempts: number;
  readonly #policy: PolicyEngine;
  readonly #registry: ToolRegistry;
  readonly #runs = new Map<string, MutableRun>();
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(
    ledger: EventLedger,
    registry: ToolRegistry,
    executor: ToolExecutor,
    policy: PolicyEngine,
    options: EngineOptions = {},
  ) {
    this.#ledger = ledger;
    this.#registry = registry;
    this.#executor = executor;
    this.#policy = policy;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maxToolAttempts = options.maxToolAttempts ?? 3;
    this.#wait = options.wait ?? (async () => undefined);
  }

  async start(
    definition: WorkflowDefinition,
    initialContext: JsonObject,
    runId = this.#idFactory(),
  ): Promise<EngineResult> {
    if (this.#runs.has(runId)) throw new InvalidTransitionError(`Run ${runId} already exists`);
    const run: MutableRun = {
      callCursor: 0,
      context: structuredClone(initialContext),
      definition,
      nextStepIndex: 0,
      runId,
      status: "running",
    };
    this.#runs.set(runId, run);
    this.#append(run, "run.started", "system", {
      definitionId: definition.id,
      version: definition.version,
    });
    return this.#advance(run);
  }

  async decide(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<EngineResult> {
    const run = this.#requireRun(runId);
    const pending = run.pendingApproval;
    if (run.status !== "waiting_for_approval" || !pending) {
      throw new InvalidTransitionError(`Run ${runId} is not waiting for approval`);
    }
    if (pending.approvalId !== approvalId) {
      throw new InvalidTransitionError(`Approval ${approvalId} is not pending for run ${runId}`);
    }

    this.#append(run, "approval.decided", decision.reviewer, {
      approvalId,
      approved: decision.approved,
      note: decision.note,
    });
    if (!decision.approved) {
      run.status = "failed";
      delete run.pendingApproval;
      this.#append(run, "run.failed", "system", {
        reason: "Human reviewer rejected a required action",
      });
      return this.#result(run);
    }

    run.status = "running";
    delete run.pendingApproval;
    await this.#executeCall(run, pending.call);
    run.callCursor += 1;
    return this.#advance(run);
  }

  snapshot(runId: string): RunSnapshot {
    return this.#snapshot(this.#requireRun(runId));
  }

  async #advance(run: MutableRun): Promise<EngineResult> {
    while (run.nextStepIndex < run.definition.steps.length) {
      const step = run.definition.steps[run.nextStepIndex];
      if (!step) throw new Error("Workflow step cursor is out of bounds");
      if (!run.proposal) {
        run.proposal = await step.propose(structuredClone(run.context));
        run.callCursor = 0;
        this.#append(run, "proposal.created", run.proposal.actor, {
          callCount: run.proposal.calls.length,
          stepId: step.id,
          summary: run.proposal.summary,
        });
      }

      while (run.callCursor < run.proposal.calls.length) {
        const call = run.proposal.calls[run.callCursor];
        if (!call) throw new Error("Tool call cursor is out of bounds");
        const tool = this.#registry.get(call.tool);
        const snapshot = this.#snapshot(run);
        const evaluation = this.#policy.evaluate({ call, run: snapshot, tool });
        this.#append(run, "policy.evaluated", "policy-engine", {
          callId: call.id,
          decisions: evaluation.decisions.map((decision) => ({
            effect: decision.effect,
            policyId: decision.policyId,
            reason: decision.reason,
          })),
          effect: evaluation.effect,
          tool: tool.name,
        });

        if (evaluation.effect === "deny") {
          run.status = "failed";
          this.#append(run, "run.failed", "policy-engine", {
            callId: call.id,
            reason: "Policy denied the proposed tool call",
          });
          return this.#result(run);
        }

        if (evaluation.effect === "require_approval") {
          const request: ApprovalRequest = {
            approvalId: this.#idFactory(),
            call,
            policyDecisions: evaluation.decisions,
            requestedAt: new Date().toISOString(),
            stepId: step.id,
          };
          run.pendingApproval = request;
          run.status = "waiting_for_approval";
          this.#append(run, "approval.requested", "policy-engine", {
            approvalId: request.approvalId,
            callId: call.id,
            stepId: step.id,
            tool: call.tool,
          });
          return this.#result(run);
        }

        await this.#executeCall(run, call);
        run.callCursor += 1;
      }

      this.#append(run, "step.completed", "system", { stepId: step.id });
      run.nextStepIndex += 1;
      run.callCursor = 0;
      delete run.proposal;
    }

    run.status = "completed";
    this.#append(run, "run.completed", "system", {
      completedSteps: run.definition.steps.length,
    });
    return this.#result(run);
  }

  async #executeCall(run: MutableRun, call: AgentProposal["calls"][number]): Promise<void> {
    const onAttempt = (attempt: ToolAttempt): void => {
      const type =
        attempt.status === "started"
          ? "tool.attempt.started"
          : attempt.status === "retryable_failure"
            ? "tool.attempt.retryable_failure"
            : attempt.status === "replayed"
              ? "tool.replayed"
              : "tool.attempt.completed";
      this.#append(run, type, "tool-runtime", {
        attempt: attempt.attempt,
        callId: call.id,
        ...(attempt.error ? { error: attempt.error } : {}),
        tool: call.tool,
      });
    };
    const result = await this.#executor.execute(
      call,
      { idempotencyKey: call.id, runId: run.runId },
      { maxAttempts: this.#maxToolAttempts, onAttempt, wait: this.#wait },
    );

    const previousResults = run.context.results;
    const results: { [key: string]: JsonValue } =
      previousResults && !Array.isArray(previousResults) && typeof previousResults === "object"
        ? structuredClone(previousResults)
        : {};
    results[call.id] = result.output;
    run.context = { ...run.context, results };
    this.#append(run, "tool.completed", "tool-runtime", {
      attempts: result.attempts,
      callId: call.id,
      output: result.output,
      replayed: result.replayed,
      tool: call.tool,
    });
  }

  #append(run: MutableRun, type: string, actor: string, data: JsonObject): void {
    this.#ledger.append(run.runId, this.#ledger.read(run.runId).length, { actor, data, type });
  }

  #requireRun(runId: string): MutableRun {
    const run = this.#runs.get(runId);
    if (!run) throw new InvalidTransitionError(`Unknown run ${runId}`);
    return run;
  }

  #snapshot(run: MutableRun): RunSnapshot {
    return {
      context: structuredClone(run.context),
      definitionId: run.definition.id,
      nextStepIndex: run.nextStepIndex,
      ...(run.pendingApproval ? { pendingApproval: structuredClone(run.pendingApproval) } : {}),
      runId: run.runId,
      status: run.status,
      version: run.definition.version,
    };
  }

  #result(run: MutableRun): EngineResult {
    this.#ledger.verify(run.runId);
    return { events: this.#ledger.read(run.runId), snapshot: this.#snapshot(run) };
  }
}
