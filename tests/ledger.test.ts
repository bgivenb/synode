import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256 } from "../src/core/canonical.js";
import { FailurePlan } from "../src/core/chaos.js";
import { ConcurrencyError, RetryableToolError } from "../src/core/errors.js";
import { InMemoryEventLedger } from "../src/core/ledger.js";

describe("canonical JSON", () => {
  it("is independent of object insertion order", () => {
    expect(canonicalize({ alpha: 1, beta: { y: 2, x: 1 } })).toBe(
      canonicalize({ beta: { x: 1, y: 2 }, alpha: 1 }),
    );
    expect(sha256({ alpha: 1 })).not.toBe(sha256({ alpha: 2 }));
  });

  it("preserves values for arbitrary string dictionaries", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
        const serialized = canonicalize(record);
        expect(JSON.parse(serialized)).toEqual(record);
      }),
    );
  });
});

describe("event ledger", () => {
  it("builds and verifies a linked hash chain", () => {
    let id = 0;
    const ledger = new InMemoryEventLedger({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      idFactory: () => `event-${++id}`,
    });
    const first = ledger.append("run-1", 0, { actor: "test", data: { value: 1 }, type: "one" });
    const second = ledger.append("run-1", 1, { actor: "test", data: { value: 2 }, type: "two" });

    expect(first.sequence).toBe(1);
    expect(second.previousHash).toBe(first.hash);
    expect(ledger.verify("run-1")).toBe(true);
    expect(ledger.read("missing")).toEqual([]);
  });

  it("rejects optimistic-concurrency conflicts", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append("run-1", 0, { actor: "test", data: {}, type: "one" });
    expect(() => ledger.append("run-1", 0, { actor: "test", data: {}, type: "two" })).toThrow(
      ConcurrencyError,
    );
  });

  it("returns defensive copies", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append("run-1", 0, { actor: "test", data: { nested: { value: 1 } }, type: "one" });
    const copy = ledger.read("run-1") as unknown as Array<{
      data: { nested?: { value?: number } };
    }>;
    if (copy[0]?.data.nested) copy[0].data.nested.value = 9;
    expect(ledger.read("run-1")[0]?.data).toEqual({ nested: { value: 1 } });
  });
});

describe("failure plan", () => {
  it("injects exactly the configured number of transient failures", () => {
    const plan = new FailurePlan().failNext("tool", 2);
    expect(() => plan.checkpoint("tool")).toThrow(RetryableToolError);
    expect(() => plan.checkpoint("tool")).toThrow(RetryableToolError);
    expect(() => plan.checkpoint("tool")).not.toThrow();
    expect(() => plan.failNext("tool", -1)).toThrow("non-negative");
  });
});
