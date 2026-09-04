import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresControlPlaneStore } from "../src/adapters/postgres.js";
import { ConcurrencyError } from "../src/core/errors.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL integration suite");

const adminPool = new Pool({ connectionString: databaseUrl });
const applicationUrl = new URL(databaseUrl);
applicationUrl.username = "synode_app";
applicationUrl.password = "synode_app";
const applicationPool = new Pool({ connectionString: applicationUrl.toString() });
const store = new PostgresControlPlaneStore(applicationPool, {
  clock: () => new Date("2026-09-04T18:00:00.000Z"),
  idFactory: (() => {
    let sequence = 0;
    return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  })(),
});

beforeAll(async () => {
  const migration = await readFile(
    new URL("../db/migrations/001_control_plane.sql", import.meta.url),
    "utf8",
  );
  await adminPool.query(migration);
  await adminPool.query(`
    DO $setup$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synode_app') THEN
        CREATE ROLE synode_app LOGIN PASSWORD 'synode_app';
      END IF;
    END
    $setup$;
    GRANT USAGE ON SCHEMA public TO synode_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO synode_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO synode_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synode_app;
  `);
});

afterAll(async () => {
  await store.close();
  await applicationPool.end();
  await adminPool.end();
});

describe("PostgreSQL control-plane adapter", () => {
  it("persists isolated, hash-linked streams with compare-and-swap appends", async () => {
    await store.createRun({
      context: { tenantId: "tenant-alpha" },
      definitionId: "case-review",
      definitionVersion: "1.0.0",
      runId: "shared-run-id",
      tenantId: "tenant-alpha",
    });
    await store.createRun({
      context: { tenantId: "tenant-beta" },
      definitionId: "case-review",
      definitionVersion: "1.0.0",
      runId: "shared-run-id",
      tenantId: "tenant-beta",
    });

    const first = await store.appendEvent("tenant-alpha", "shared-run-id", 0, {
      actor: "integration-test",
      data: { value: 1 },
      type: "run.started",
    });
    const second = await store.appendEvent("tenant-alpha", "shared-run-id", 1, {
      actor: "integration-test",
      data: { value: 2 },
      type: "step.completed",
    });

    expect(second.previousHash).toBe(first.hash);
    expect(await store.readEvents("tenant-alpha", "shared-run-id")).toEqual([first, second]);
    expect(await store.readEvents("tenant-beta", "shared-run-id")).toEqual([]);
    await expect(
      store.appendEvent("tenant-alpha", "shared-run-id", 0, {
        actor: "stale-writer",
        data: {},
        type: "invalid",
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("leases transactional-outbox messages once and checks worker ownership", async () => {
    const id = await store.enqueueTool(
      "tenant-alpha",
      "shared-run-id",
      "release-case-hold",
      "case.release",
      { caseId: "case-0142" },
    );
    expect(
      await store.enqueueTool(
        "tenant-alpha",
        "shared-run-id",
        "release-case-hold",
        "case.release",
        { caseId: "case-0142" },
      ),
    ).toBe(id);

    const claimed = await store.claimToolBatch("tenant-alpha", "worker-a", 5, 30);
    expect(claimed).toEqual([
      expect.objectContaining({
        attemptCount: 1,
        id,
        idempotencyKey: "release-case-hold",
        toolName: "case.release",
      }),
    ]);
    expect(await store.claimToolBatch("tenant-alpha", "worker-b", 5, 30)).toEqual([]);
    await expect(store.completeTool("tenant-alpha", id, "worker-b")).rejects.toThrow(
      "not leased by this worker",
    );
    await store.completeTool("tenant-alpha", id, "worker-a");
  });

  it("enforces row-level security even when a query omits its tenant predicate", async () => {
    const unscoped = await applicationPool.query<{ readonly count: string }>(
      "SELECT count(*) FROM workflow_runs",
    );
    expect(Number(unscoped.rows[0]?.count)).toBe(0);

    const scoped = await applicationPool.connect();
    try {
      await scoped.query("BEGIN");
      await scoped.query("SELECT set_config('app.tenant_id', 'tenant-alpha', true)");
      const visible = await scoped.query<{ readonly id: string }>(
        "SELECT id FROM workflow_runs ORDER BY id",
      );
      expect(visible.rows).toEqual([{ id: "shared-run-id" }]);
      await expect(
        scoped.query("UPDATE run_events SET actor = 'tampered' WHERE tenant_id = 'tenant-alpha'"),
      ).rejects.toThrow("run_events is append-only");
      await scoped.query("ROLLBACK");
    } finally {
      scoped.release();
    }
  });

  it("runs tenant-scoped keyword and graph retrieval in PostgreSQL", async () => {
    const client = await applicationPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', 'tenant-alpha', true)");
      await client.query(`
        INSERT INTO knowledge_nodes (tenant_id, id, kind, classification, attributes)
        VALUES
          ('tenant-alpha', 'case-0142', 'case', 'internal', '{}'),
          ('tenant-alpha', 'evidence-0088', 'evidence', 'internal', '{}');
        INSERT INTO knowledge_edges (tenant_id, id, source_id, target_id, relation)
        VALUES ('tenant-alpha', 'supports', 'case-0142', 'evidence-0088', 'supported_by');
        INSERT INTO knowledge_chunks
          (tenant_id, id, node_id, classification, source_uri, content)
        VALUES
          ('tenant-alpha', 'chunk-case', 'case-0142', 'internal', 'urn:case:0142',
           'Synthetic operational review'),
          ('tenant-alpha', 'chunk-evidence', 'evidence-0088', 'internal', 'urn:evidence:0088',
           'Verified ownership evidence');
      `);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const hits = await store.retrieveKnowledge({
      allowedClassifications: ["internal"],
      anchorIds: ["case-0142"],
      limit: 5,
      maxDepth: 2,
      query: "verified ownership",
      tenantId: "tenant-alpha",
    });
    expect(hits.map((hit) => hit.id)).toEqual(["chunk-evidence", "chunk-case"]);
    expect(hits[0]).toMatchObject({
      channels: ["graph", "keyword"],
      graphPath: ["case-0142", "evidence-0088"],
      sourceUri: "urn:evidence:0088",
    });
  });
});
