import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Pool } from "pg";
import { PostgresControlPlaneStore } from "./adapters/postgres.js";
import { HttpToolDispatcher, OutboxWorker } from "./runtime/outbox-worker.js";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pool = new Pool();
const store = new PostgresControlPlaneStore(pool);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

const worker = new OutboxWorker(
  store,
  new HttpToolDispatcher(requireEnvironment("TOOL_HANDLER_ENDPOINT")),
  {
    tenantId: requireEnvironment("TENANT_SHARD"),
    workerId: `${hostname()}:${randomUUID()}`,
  },
);

try {
  await worker.run(controller.signal);
} finally {
  await pool.end();
}
