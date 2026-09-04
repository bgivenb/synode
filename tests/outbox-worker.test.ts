import { describe, expect, it } from "vitest";
import type { OutboxMessage } from "../src/adapters/postgres.js";
import {
  type OutboxLeaseStore,
  OutboxWorker,
  type ToolDispatcher,
} from "../src/runtime/outbox-worker.js";

function message(id: number, attemptCount = 1): OutboxMessage {
  return {
    attemptCount,
    id,
    idempotencyKey: `call-${id}`,
    payload: { caseId: `case-${id}` },
    runId: "run-1",
    toolName: "case.release",
  };
}

class FakeStore implements OutboxLeaseStore {
  readonly completed: number[] = [];
  readonly failures: { error: string; id: number; maxAttempts: number }[] = [];
  messages: readonly OutboxMessage[] = [];

  async claimToolBatch(): Promise<readonly OutboxMessage[]> {
    const claimed = this.messages;
    this.messages = [];
    return claimed;
  }

  async completeTool(_tenantId: string, messageId: number): Promise<void> {
    this.completed.push(messageId);
  }

  async failTool(
    _tenantId: string,
    messageId: number,
    _workerId: string,
    error: string,
    maxAttempts: number,
  ): Promise<"dead_letter" | "pending"> {
    this.failures.push({ error, id: messageId, maxAttempts });
    const attempt = this.messages.find((item) => item.id === messageId)?.attemptCount;
    return attempt && attempt >= maxAttempts ? "dead_letter" : "pending";
  }
}

describe("outbox worker", () => {
  it("completes only calls acknowledged by the tool adapter", async () => {
    const store = new FakeStore();
    store.messages = [message(1), message(2)];
    const dispatcher: ToolDispatcher = {
      async dispatch(item) {
        if (item.id === 2) throw new Error("dependency unavailable");
      },
    };
    const worker = new OutboxWorker(store, dispatcher, {
      tenantId: "northstar",
      workerId: "worker-a",
    });

    expect(await worker.runOnce()).toEqual({
      completed: 1,
      deadLettered: 0,
      leased: 2,
      retrying: 1,
    });
    expect(store.completed).toEqual([1]);
    expect(store.failures).toEqual([{ error: "dependency unavailable", id: 2, maxAttempts: 5 }]);
  });

  it("moves exhausted calls to the dead-letter state", async () => {
    const store = new FakeStore();
    store.messages = [message(3, 5)];
    const attempts = new Map([[3, 5]]);
    store.failTool = async (_tenantId, id, _workerId, error, maxAttempts) => {
      store.failures.push({ error, id, maxAttempts });
      return (attempts.get(id) ?? 0) >= maxAttempts ? "dead_letter" : "pending";
    };
    const worker = new OutboxWorker(
      store,
      {
        async dispatch() {
          throw new Error("permanent failure");
        },
      },
      { maxAttempts: 5, tenantId: "northstar", workerId: "worker-a" },
    );

    expect(await worker.runOnce()).toMatchObject({ deadLettered: 1, retrying: 0 });
  });
});
