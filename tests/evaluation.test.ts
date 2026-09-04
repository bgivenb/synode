import { describe, expect, it } from "vitest";
import { evaluate } from "../src/core/evaluation.js";

describe("evaluation harness", () => {
  it("reports passing and failing scenarios without hiding assertions", async () => {
    const report = await evaluate([
      {
        id: "pass",
        name: "passes",
        async run() {
          return [{ actual: true, expected: true, label: "truth" }];
        },
      },
      {
        id: "fail",
        name: "fails",
        async run() {
          return [{ actual: 1, expected: 2, label: "numbers" }];
        },
      },
    ]);
    expect(report).toEqual(expect.objectContaining({ failed: 1, passed: 1, total: 2 }));
    expect(report.cases[1]?.assertions[0]?.passed).toBe(false);
  });
});
