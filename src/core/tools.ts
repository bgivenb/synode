import type { z } from "zod";
import { sha256 } from "./canonical.js";
import { RetryableToolError } from "./errors.js";
import type { JsonObject, ToolCall, ToolDefinition, ToolExecutionContext } from "./types.js";

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly output: JsonObject;
}

export interface ToolAttempt {
  readonly attempt: number;
  readonly error?: string;
  readonly status: "started" | "retryable_failure" | "completed" | "replayed";
}

export interface ExecutionOptions {
  readonly maxAttempts?: number;
  readonly onAttempt?: (attempt: ToolAttempt) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface ToolExecutionResult {
  readonly attempts: number;
  readonly output: JsonObject;
  readonly replayed: boolean;
}

export class InMemoryIdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  get(key: string): IdempotencyRecord | undefined {
    const record = this.#records.get(key);
    return record ? structuredClone(record) : undefined;
  }

  set(key: string, record: IdempotencyRecord): void {
    this.#records.set(key, structuredClone(record));
  }
}

export class ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>();

  register<Input extends JsonObject, Output extends JsonObject>(
    definition: ToolDefinition<Input, Output>,
  ): void {
    if (this.#definitions.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered`);
    }
    this.#definitions.set(definition.name, definition as ToolDefinition);
  }

  get(name: string): ToolDefinition {
    const definition = this.#definitions.get(name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    return definition;
  }

  list(): readonly ToolDefinition[] {
    return [...this.#definitions.values()];
  }
}

export class ToolExecutor {
  readonly #idempotency: InMemoryIdempotencyStore;
  readonly #registry: ToolRegistry;

  constructor(registry: ToolRegistry, idempotency = new InMemoryIdempotencyStore()) {
    this.#registry = registry;
    this.#idempotency = idempotency;
  }

  async execute(
    call: ToolCall,
    context: Omit<ToolExecutionContext, "attempt">,
    options: ExecutionOptions = {},
  ): Promise<ToolExecutionResult> {
    const definition = this.#registry.get(call.tool);
    const input = definition.inputSchema.parse(call.input) as JsonObject;
    const key = `${context.runId}:${context.idempotencyKey}`;
    const fingerprint = sha256({ input, tool: call.tool });
    const existing = this.#idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`Idempotency key ${context.idempotencyKey} was reused with new input`);
      }
      options.onAttempt?.({ attempt: 0, status: "replayed" });
      return { attempts: 0, output: existing.output, replayed: true };
    }

    const maxAttempts = options.maxAttempts ?? 3;
    const wait = options.wait ?? (async () => undefined);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.onAttempt?.({ attempt, status: "started" });
      try {
        const output = await definition.execute(input, { ...context, attempt });
        this.#idempotency.set(key, { fingerprint, output });
        options.onAttempt?.({ attempt, status: "completed" });
        return { attempts: attempt, output, replayed: false };
      } catch (error) {
        if (!(error instanceof RetryableToolError) || attempt === maxAttempts) throw error;
        options.onAttempt?.({ attempt, error: error.message, status: "retryable_failure" });
        await wait(2 ** (attempt - 1) * 100);
      }
    }
    throw new Error("Unreachable retry state");
  }
}

export type InferToolInput<T extends z.ZodType> = z.infer<T>;
