import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { ConcurrencyError } from "../core/errors.js";
import type {
  Classification,
  EventDraft,
  JsonObject,
  LedgerEvent,
  RunStatus,
} from "../core/types.js";

interface PostgresEventRow extends QueryResultRow {
  readonly actor: string;
  readonly data: JsonObject;
  readonly event_id: string;
  readonly hash: string;
  readonly occurred_at: Date | string;
  readonly previous_hash: string | null;
  readonly run_id: string;
  readonly sequence: number | string;
  readonly type: string;
}

export interface DurableRunInput {
  readonly context: JsonObject;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly runId: string;
  readonly status?: RunStatus;
  readonly tenantId: string;
}

export interface OutboxMessage {
  readonly attemptCount: number;
  readonly id: number;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
  readonly runId: string;
  readonly toolName: string;
}

export interface PostgresStoreOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface PersistentRetrievalHit {
  readonly channels: readonly string[];
  readonly classification: Classification;
  readonly content: string;
  readonly graphPath: readonly string[] | null;
  readonly id: string;
  readonly nodeId: string;
  readonly rankByChannel: Readonly<Record<string, number>>;
  readonly score: number;
  readonly sourceUri: string;
}

export interface PersistentRetrievalRequest {
  readonly allowedClassifications: readonly Classification[];
  readonly anchorIds: readonly string[];
  readonly embedding?: readonly number[];
  readonly limit: number;
  readonly maxDepth: number;
  readonly query: string;
  readonly tenantId: string;
}

function isDatabaseError(value: unknown): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}

function asEvent(row: PostgresEventRow): LedgerEvent {
  return {
    actor: row.actor,
    data: row.data,
    eventId: row.event_id,
    hash: row.hash,
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
    previousHash: row.previous_hash,
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
  };
}

/**
 * PostgreSQL adapter for the durable control-plane boundary.
 *
 * Every operation runs in an explicit transaction with a transaction-local tenant setting. The
 * migration applies row-level security to this setting, so callers cannot accidentally query a
 * second tenant by adding a different predicate. Event appends serialize on the run row and use a
 * compare-and-swap sequence inside the database.
 */
export class PostgresControlPlaneStore {
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #ownsPool: boolean;
  readonly #pool: Pool;

  constructor(connection: string | Pool, options: PostgresStoreOptions = {}) {
    this.#ownsPool = typeof connection === "string";
    this.#pool =
      typeof connection === "string" ? new Pool({ connectionString: connection }) : connection;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async ensureTenant(tenantId: string, displayName = tenantId): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tenants (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [tenantId, displayName],
    );
  }

  async createRun(input: DurableRunInput): Promise<void> {
    await this.ensureTenant(input.tenantId);
    await this.#withTenant(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO workflow_runs
           (tenant_id, id, definition_id, definition_version, status, context)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.tenantId,
          input.runId,
          input.definitionId,
          input.definitionVersion,
          input.status ?? "running",
          input.context,
        ],
      );
    });
  }

  async appendEvent(
    tenantId: string,
    runId: string,
    expectedSequence: number,
    event: EventDraft,
  ): Promise<LedgerEvent> {
    try {
      return await this.#withTenant(tenantId, async (client) => {
        const result = await client.query<PostgresEventRow>(
          `SELECT * FROM append_run_event($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            tenantId,
            runId,
            expectedSequence,
            this.#idFactory(),
            event.type,
            event.actor,
            event.data,
            this.#clock(),
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Event append returned no row");
        return asEvent(row);
      });
    } catch (error) {
      if (isDatabaseError(error) && error.code === "40001") {
        throw new ConcurrencyError(`Expected event sequence ${expectedSequence} for run ${runId}`);
      }
      throw error;
    }
  }

  async readEvents(tenantId: string, runId: string): Promise<readonly LedgerEvent[]> {
    return this.#withTenant(tenantId, async (client) => {
      const result = await client.query<PostgresEventRow>(
        `SELECT event_id, run_id, sequence, occurred_at, type, actor, data, previous_hash, hash
         FROM run_events
         WHERE tenant_id = $1 AND run_id = $2
         ORDER BY sequence`,
        [tenantId, runId],
      );
      return result.rows.map(asEvent);
    });
  }

  async retrieveKnowledge(
    request: PersistentRetrievalRequest,
  ): Promise<readonly PersistentRetrievalHit[]> {
    if (request.embedding && request.embedding.length !== 384) {
      throw new Error("PostgreSQL reference schema requires 384-dimensional embeddings");
    }
    return this.#withTenant(request.tenantId, async (client) => {
      const result = await client.query<
        QueryResultRow & {
          readonly channels: string[];
          readonly classification: Classification;
          readonly content: string;
          readonly graph_path: string[] | null;
          readonly id: string;
          readonly node_id: string;
          readonly rank_by_channel: Record<string, number>;
          readonly score: number | string;
          readonly source_uri: string;
        }
      >(
        `SELECT *
         FROM hybrid_retrieve($1, $2, $3::vector(384), $4, $5, $6, $7)`,
        [
          request.tenantId,
          request.query,
          request.embedding ? `[${request.embedding.join(",")}]` : null,
          request.anchorIds,
          request.allowedClassifications,
          request.maxDepth,
          request.limit,
        ],
      );
      return result.rows.map((row) => ({
        channels: row.channels,
        classification: row.classification,
        content: row.content,
        graphPath: row.graph_path,
        id: row.id,
        nodeId: row.node_id,
        rankByChannel: row.rank_by_channel,
        score: Number(row.score),
        sourceUri: row.source_uri,
      }));
    });
  }

  async enqueueTool(
    tenantId: string,
    runId: string,
    idempotencyKey: string,
    toolName: string,
    payload: JsonObject,
  ): Promise<number> {
    return this.#withTenant(tenantId, async (client) => {
      const result = await client.query<{ readonly id: number | string }>(
        `INSERT INTO tool_outbox
           (tenant_id, run_id, idempotency_key, tool_name, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, run_id, idempotency_key)
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id`,
        [tenantId, runId, idempotencyKey, toolName, payload],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Outbox enqueue returned no row");
      return Number(row.id);
    });
  }

  async claimToolBatch(
    tenantId: string,
    workerId: string,
    limit = 10,
    leaseSeconds = 30,
  ): Promise<readonly OutboxMessage[]> {
    if (limit < 1 || limit > 100) throw new Error("claim limit must be between 1 and 100");
    if (leaseSeconds < 1) throw new Error("lease duration must be positive");
    return this.#withTenant(tenantId, async (client) => {
      const result = await client.query<
        QueryResultRow & {
          readonly attempt_count: number;
          readonly id: number | string;
          readonly idempotency_key: string;
          readonly payload: JsonObject;
          readonly run_id: string;
          readonly tool_name: string;
        }
      >(
        `WITH candidates AS (
           SELECT id
           FROM tool_outbox
           WHERE tenant_id = $1
             AND available_at <= now()
             AND (state = 'pending' OR (state = 'leased' AND leased_until < now()))
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE tool_outbox AS outbox
         SET state = 'leased',
             lease_owner = $3,
             leased_until = now() + make_interval(secs => $4),
             attempt_count = attempt_count + 1
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.id, outbox.run_id, outbox.idempotency_key, outbox.tool_name,
                   outbox.payload, outbox.attempt_count`,
        [tenantId, limit, workerId, leaseSeconds],
      );
      return result.rows.map((row) => ({
        attemptCount: row.attempt_count,
        id: Number(row.id),
        idempotencyKey: row.idempotency_key,
        payload: row.payload,
        runId: row.run_id,
        toolName: row.tool_name,
      }));
    });
  }

  async completeTool(tenantId: string, messageId: number, workerId: string): Promise<void> {
    await this.#withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tool_outbox
         SET state = 'completed', leased_until = NULL, lease_owner = NULL
         WHERE tenant_id = $1 AND id = $2 AND state = 'leased' AND lease_owner = $3`,
        [tenantId, messageId, workerId],
      );
      if (result.rowCount !== 1) throw new Error("Tool message is not leased by this worker");
    });
  }

  async failTool(
    tenantId: string,
    messageId: number,
    workerId: string,
    error: string,
    maxAttempts = 5,
  ): Promise<"dead_letter" | "pending"> {
    return this.#withTenant(tenantId, async (client) => {
      const result = await client.query<{ readonly state: "dead_letter" | "pending" }>(
        `UPDATE tool_outbox
         SET state = CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'pending' END,
             available_at = now() + make_interval(secs => power(2, least(attempt_count, 8))::integer),
             leased_until = NULL,
             lease_owner = NULL,
             last_error = left($5, 1000)
         WHERE tenant_id = $1 AND id = $2 AND state = 'leased' AND lease_owner = $3
         RETURNING state`,
        [tenantId, messageId, workerId, maxAttempts, error],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Tool message is not leased by this worker");
      return row.state;
    });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async #withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
