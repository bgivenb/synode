import { IntegrityError } from "./errors.js";
import type { JsonObject, LedgerEvent, RunStatus } from "./types.js";

export interface ReplayProjection {
  readonly approvals: number;
  readonly deniedCalls: number;
  readonly results: Readonly<Record<string, JsonObject>>;
  readonly retries: number;
  readonly runId: string;
  readonly status: RunStatus;
  readonly toolAttempts: number;
}

export function replay(events: readonly LedgerEvent[]): ReplayProjection {
  if (events.length === 0) throw new IntegrityError("Cannot replay an empty event stream");
  const runId = events[0]?.runId;
  if (!runId) throw new IntegrityError("The first event has no run identifier");

  let approvals = 0;
  let deniedCalls = 0;
  let retries = 0;
  let status: RunStatus = "running";
  let toolAttempts = 0;
  const results: Record<string, JsonObject> = {};

  for (const [index, event] of events.entries()) {
    if (event.runId !== runId || event.sequence !== index + 1) {
      throw new IntegrityError(`Non-contiguous stream at event ${event.eventId}`);
    }
    switch (event.type) {
      case "approval.requested":
        status = "waiting_for_approval";
        break;
      case "approval.decided":
        approvals += 1;
        status = event.data.approved === true ? "running" : "failed";
        break;
      case "policy.evaluated":
        if (event.data.effect === "deny") deniedCalls += 1;
        break;
      case "run.completed":
        status = "completed";
        break;
      case "run.failed":
        status = "failed";
        break;
      case "tool.attempt.retryable_failure":
        retries += 1;
        break;
      case "tool.attempt.started":
        toolAttempts += 1;
        break;
      case "tool.completed": {
        const callId = event.data.callId;
        const output = event.data.output;
        if (
          typeof callId === "string" &&
          output &&
          !Array.isArray(output) &&
          typeof output === "object"
        ) {
          results[callId] = output;
        }
        break;
      }
    }
  }

  return { approvals, deniedCalls, results, retries, runId, status, toolAttempts };
}
