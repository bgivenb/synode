import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoReport } from "./scenario.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const report = await createDemoReport();
const output = `${JSON.stringify(report, null, 2)}\n`;

await mkdir(resolve(root, "artifacts"), { recursive: true });
await mkdir(resolve(root, "docs/data"), { recursive: true });
await writeFile(resolve(root, "artifacts/demo-run.json"), output, "utf8");
await writeFile(resolve(root, "docs/data/demo-run.json"), output, "utf8");

console.log(`Synode demo: ${report.run.status}`);
console.log(
  `${report.metrics.events} events · ${report.metrics.approvals} approval · ${report.metrics.retries} recovered failure`,
);
console.log(
  `${report.evaluation.passed}/${report.evaluation.total} evaluation scenarios passed · ledger ${report.metrics.ledgerValid ? "verified" : "invalid"}`,
);
