import { describe, expect, it } from "vitest";
import { createDemoReport } from "../src/demo/scenario.js";

describe("synthetic research scenario", () => {
  it("completes only after approval and recovers one injected failure", async () => {
    const report = await createDemoReport();
    expect(report.meta.synthetic).toBe(true);
    expect(report.run.status).toBe("completed");
    expect(report.metrics).toEqual(
      expect.objectContaining({ approvals: 1, ledgerValid: true, retries: 1, toolsCompleted: 3 }),
    );
    expect(report.evaluation).toEqual(expect.objectContaining({ failed: 0, passed: 2 }));
    expect(report.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.decided",
        "tool.attempt.retryable_failure",
        "run.completed",
      ]),
    );
  });
});
