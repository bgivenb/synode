import { setTimeout as wait } from "node:timers/promises";
import type { OutboxMessage } from "../adapters/postgres.js";

export interface OutboxLeaseStore {
  claimToolBatch(
    tenantId: string,
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly OutboxMessage[]>;
  completeTool(tenantId: string, messageId: number, workerId: string): Promise<void>;
  failTool(
    tenantId: string,
    messageId: number,
    workerId: string,
    error: string,
    maxAttempts: number,
  ): Promise<"dead_letter" | "pending">;
}

export interface ToolDispatcher {
  dispatch(message: OutboxMessage, signal: AbortSignal): Promise<void>;
}

export interface OutboxWorkerOptions {
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly maxAttempts?: number;
  readonly pollMilliseconds?: number;
  readonly tenantId: string;
  readonly workerId: string;
}

export interface WorkerCycleResult {
  readonly completed: number;
  readonly deadLettered: number;
  readonly leased: number;
  readonly retrying: number;
}

export class HttpToolDispatcher implements ToolDispatcher {
  readonly #baseUrl: URL;
  readonly #requestTimeoutMilliseconds: number;

  constructor(baseUrl: string, requestTimeoutMilliseconds = 15_000) {
    this.#baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
  }

  async dispatch(message: OutboxMessage, signal: AbortSignal): Promise<void> {
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#requestTimeoutMilliseconds),
    ]);
    const response = await fetch(
      new URL(`tools/${encodeURIComponent(message.toolName)}`, this.#baseUrl),
      {
        body: JSON.stringify(message.payload),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
          "X-Synode-Run": message.runId,
        },
        method: "POST",
        signal: requestSignal,
      },
    );
    if (!response.ok) throw new Error(`Tool adapter returned HTTP ${response.status}`);
  }
}

export class OutboxWorker {
  readonly #batchSize: number;
  readonly #dispatcher: ToolDispatcher;
  readonly #leaseSeconds: number;
  readonly #maxAttempts: number;
  readonly #pollMilliseconds: number;
  readonly #store: OutboxLeaseStore;
  readonly #tenantId: string;
  readonly #workerId: string;

  constructor(store: OutboxLeaseStore, dispatcher: ToolDispatcher, options: OutboxWorkerOptions) {
    this.#store = store;
    this.#dispatcher = dispatcher;
    this.#tenantId = options.tenantId;
    this.#workerId = options.workerId;
    this.#batchSize = options.batchSize ?? 10;
    this.#leaseSeconds = options.leaseSeconds ?? 30;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#pollMilliseconds = options.pollMilliseconds ?? 500;
  }

  async runOnce(signal = new AbortController().signal): Promise<WorkerCycleResult> {
    const messages = await this.#store.claimToolBatch(
      this.#tenantId,
      this.#workerId,
      this.#batchSize,
      this.#leaseSeconds,
    );
    let completed = 0;
    let deadLettered = 0;
    let retrying = 0;

    await Promise.all(
      messages.map(async (message) => {
        try {
          await this.#dispatcher.dispatch(message, signal);
          await this.#store.completeTool(this.#tenantId, message.id, this.#workerId);
          completed += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Unknown tool adapter failure";
          const state = await this.#store.failTool(
            this.#tenantId,
            message.id,
            this.#workerId,
            reason,
            this.#maxAttempts,
          );
          if (state === "dead_letter") deadLettered += 1;
          else retrying += 1;
        }
      }),
    );
    return { completed, deadLettered, leased: messages.length, retrying };
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cycle = await this.runOnce(signal);
      if (cycle.leased === 0) {
        try {
          await wait(this.#pollMilliseconds, undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    }
  }
}
