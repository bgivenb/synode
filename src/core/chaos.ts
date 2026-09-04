import { RetryableToolError } from "./errors.js";

export class FailurePlan {
  readonly #remaining = new Map<string, number>();

  failNext(key: string, count = 1): this {
    if (!Number.isInteger(count) || count < 0)
      throw new Error("Failure count must be non-negative");
    this.#remaining.set(key, count);
    return this;
  }

  checkpoint(key: string): void {
    const remaining = this.#remaining.get(key) ?? 0;
    if (remaining <= 0) return;
    this.#remaining.set(key, remaining - 1);
    throw new RetryableToolError(`Injected transient failure at ${key}`);
  }
}
