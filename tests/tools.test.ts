import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RetryableToolError } from "../src/core/errors.js";
import { ToolExecutor, ToolRegistry } from "../src/core/tools.js";

const schema = z.object({ value: z.number() });

describe("tool runtime", () => {
  it("validates inputs, retries transient failures, and records idempotent results", async () => {
    const registry = new ToolRegistry();
    let invocations = 0;
    registry.register({
      description: "double a number",
      inputSchema: schema,
      name: "math.double",
      reversible: true,
      risk: "low",
      async execute(input) {
        invocations += 1;
        if (invocations === 1) throw new RetryableToolError("temporary");
        return { doubled: input.value * 2 };
      },
    });
    const executor = new ToolExecutor(registry);
    const attempts: string[] = [];
    const wait = vi.fn(async () => undefined);
    const call = {
      id: "double-1",
      input: { value: 4 },
      justification: "test",
      tool: "math.double",
    };

    const first = await executor.execute(
      call,
      { idempotencyKey: call.id, runId: "run" },
      {
        onAttempt: (attempt) => attempts.push(attempt.status),
        wait,
      },
    );
    const second = await executor.execute(call, { idempotencyKey: call.id, runId: "run" });

    expect(first).toEqual({ attempts: 2, output: { doubled: 8 }, replayed: false });
    expect(second).toEqual({ attempts: 0, output: { doubled: 8 }, replayed: true });
    expect(attempts).toEqual(["started", "retryable_failure", "started", "completed"]);
    expect(wait).toHaveBeenCalledWith(100);
    expect(invocations).toBe(2);
  });

  it("rejects invalid input and idempotency-key reuse with changed input", async () => {
    const registry = new ToolRegistry();
    registry.register({
      description: "echo",
      inputSchema: schema,
      name: "echo",
      reversible: true,
      risk: "low",
      async execute(input) {
        return input;
      },
    });
    const executor = new ToolExecutor(registry);
    await expect(
      executor.execute(
        { id: "bad", input: { value: "no" }, justification: "test", tool: "echo" },
        { idempotencyKey: "bad", runId: "run" },
      ),
    ).rejects.toThrow();
    await executor.execute(
      { id: "same", input: { value: 1 }, justification: "test", tool: "echo" },
      { idempotencyKey: "same", runId: "run" },
    );
    await expect(
      executor.execute(
        { id: "same", input: { value: 2 }, justification: "test", tool: "echo" },
        { idempotencyKey: "same", runId: "run" },
      ),
    ).rejects.toThrow("reused with new input");
  });

  it("rejects unknown and duplicate tool definitions", () => {
    const registry = new ToolRegistry();
    const definition = {
      description: "echo",
      inputSchema: schema,
      name: "echo",
      reversible: true,
      risk: "low" as const,
      async execute(input: z.infer<typeof schema>) {
        return input;
      },
    };
    registry.register(definition);
    expect(registry.list()).toHaveLength(1);
    expect(() => registry.register(definition)).toThrow("already registered");
    expect(() => registry.get("missing")).toThrow("Unknown tool");
  });

  it("stops retrying at the configured attempt limit", async () => {
    const registry = new ToolRegistry();
    registry.register({
      description: "fail",
      inputSchema: schema,
      name: "fail",
      reversible: true,
      risk: "low",
      async execute() {
        throw new RetryableToolError("still unavailable");
      },
    });
    const executor = new ToolExecutor(registry);
    await expect(
      executor.execute(
        { id: "fail", input: { value: 1 }, justification: "test", tool: "fail" },
        { idempotencyKey: "fail", runId: "run" },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow("still unavailable");
  });
});
