import { randomUUID } from "node:crypto";
import { sha256 } from "./canonical.js";
import { ConcurrencyError, IntegrityError } from "./errors.js";
import type { EventDraft, JsonObject, LedgerEvent } from "./types.js";

export interface EventLedger {
  append(runId: string, expectedSequence: number, event: EventDraft): LedgerEvent;
  read(runId: string): readonly LedgerEvent[];
  verify(runId: string): boolean;
}

interface LedgerOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

function hashInput(event: Omit<LedgerEvent, "hash">): JsonObject {
  return {
    actor: event.actor,
    data: event.data,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    previousHash: event.previousHash,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
  };
}

export class InMemoryEventLedger implements EventLedger {
  readonly #clock: () => Date;
  readonly #events = new Map<string, LedgerEvent[]>();
  readonly #idFactory: () => string;

  constructor(options: LedgerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  append(runId: string, expectedSequence: number, draft: EventDraft): LedgerEvent {
    const stream = this.#events.get(runId) ?? [];
    if (stream.length !== expectedSequence) {
      throw new ConcurrencyError(
        `Expected event sequence ${expectedSequence}; current sequence is ${stream.length}`,
      );
    }

    const unsigned: Omit<LedgerEvent, "hash"> = {
      ...draft,
      eventId: this.#idFactory(),
      occurredAt: this.#clock().toISOString(),
      previousHash: stream.at(-1)?.hash ?? null,
      runId,
      sequence: expectedSequence + 1,
    };
    const event: LedgerEvent = { ...unsigned, hash: sha256(hashInput(unsigned)) };
    stream.push(event);
    this.#events.set(runId, stream);
    return event;
  }

  read(runId: string): readonly LedgerEvent[] {
    return structuredClone(this.#events.get(runId) ?? []);
  }

  verify(runId: string): boolean {
    const events = this.#events.get(runId) ?? [];
    let previousHash: string | null = null;
    for (const [index, event] of events.entries()) {
      if (
        event.sequence !== index + 1 ||
        event.previousHash !== previousHash ||
        event.hash !== sha256(hashInput(event))
      ) {
        throw new IntegrityError(`Ledger verification failed at sequence ${event.sequence}`);
      }
      previousHash = event.hash;
    }
    return true;
  }
}
