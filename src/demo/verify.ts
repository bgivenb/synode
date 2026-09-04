import { createDemoReport } from "./scenario.js";

const report = await createDemoReport();
if (report.run.status !== "completed") throw new Error(`Unexpected status: ${report.run.status}`);
if (!report.metrics.ledgerValid) throw new Error("Demo ledger did not verify");
if (report.evaluation.failed > 0) throw new Error("One or more demo evaluations failed");
if (report.graph.nodes.some((node) => node.tenantId !== "northstar-demo")) {
  throw new Error("Tenant isolation failure in exported graph");
}

console.log(
  `Verified ${report.events.length} events, ${report.graph.nodes.length} graph nodes, and ${report.evaluation.total} evaluation scenarios.`,
);
