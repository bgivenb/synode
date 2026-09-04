BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  definition_id text NOT NULL,
  definition_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'waiting_for_approval', 'completed', 'failed')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS run_events (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  actor text NOT NULL,
  data jsonb NOT NULL,
  previous_hash text,
  hash text NOT NULL,
  PRIMARY KEY (tenant_id, run_id, sequence),
  UNIQUE (event_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_events_type_idx
  ON run_events (tenant_id, type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  step_id text NOT NULL,
  tool_call jsonb NOT NULL,
  policy_decisions jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  reviewer_subject text,
  rationale text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND reviewer_subject IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND reviewer_subject IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_call_idx
  ON approvals (tenant_id, run_id, ((tool_call ->> 'id')))
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text NOT NULL,
  intent_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, run_id, idempotency_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  idempotency_key text NOT NULL,
  tool_name text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  lease_owner text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, run_id, idempotency_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_outbox_claim_idx
  ON tool_outbox (tenant_id, state, available_at, id)
  WHERE state IN ('pending', 'leased');

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  kind text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  tenant_id text NOT NULL,
  id text NOT NULL,
  source_id text NOT NULL,
  target_id text NOT NULL,
  relation text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_nodes(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_id) REFERENCES knowledge_nodes(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS knowledge_edges_source_idx
  ON knowledge_edges (tenant_id, source_id, relation);
CREATE INDEX IF NOT EXISTS knowledge_edges_target_idx
  ON knowledge_edges (tenant_id, target_id, relation);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  node_id text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('public', 'internal', 'restricted')),
  source_uri text NOT NULL,
  content text NOT NULL,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding vector(384),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, node_id) REFERENCES knowledge_nodes(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx
  ON knowledge_chunks USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_run_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'run_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS run_events_immutable ON run_events;
CREATE TRIGGER run_events_immutable
  BEFORE UPDATE OR DELETE ON run_events
  FOR EACH ROW EXECUTE FUNCTION reject_run_event_mutation();

CREATE OR REPLACE FUNCTION append_run_event(
  p_tenant_id text,
  p_run_id text,
  p_expected_sequence bigint,
  p_event_id uuid,
  p_type text,
  p_actor text,
  p_data jsonb,
  p_occurred_at timestamptz
)
RETURNS run_events
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_sequence bigint;
  v_previous_hash text;
  v_payload jsonb;
  v_hash text;
  v_event run_events;
BEGIN
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'tenant context does not match append request';
  END IF;

  SELECT current_sequence
  INTO v_current_sequence
  FROM workflow_runs
  WHERE tenant_id = p_tenant_id AND id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow run not found';
  END IF;
  IF v_current_sequence <> p_expected_sequence THEN
    RAISE EXCEPTION 'expected sequence %, current sequence %', p_expected_sequence, v_current_sequence
      USING ERRCODE = '40001';
  END IF;

  SELECT hash INTO v_previous_hash
  FROM run_events
  WHERE tenant_id = p_tenant_id AND run_id = p_run_id AND sequence = v_current_sequence;

  v_payload := jsonb_build_object(
    'actor', p_actor,
    'data', p_data,
    'eventId', p_event_id,
    'occurredAt', p_occurred_at,
    'previousHash', v_previous_hash,
    'runId', p_run_id,
    'sequence', v_current_sequence + 1,
    'type', p_type
  );
  v_hash := encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO run_events (
    tenant_id, run_id, sequence, event_id, occurred_at, type, actor, data, previous_hash, hash
  ) VALUES (
    p_tenant_id, p_run_id, v_current_sequence + 1, p_event_id, p_occurred_at,
    p_type, p_actor, p_data, v_previous_hash, v_hash
  ) RETURNING * INTO v_event;

  UPDATE workflow_runs
  SET current_sequence = v_current_sequence + 1, updated_at = p_occurred_at
  WHERE tenant_id = p_tenant_id AND id = p_run_id;

  RETURN v_event;
END;
$$;

CREATE OR REPLACE FUNCTION hybrid_retrieve(
  p_tenant_id text,
  p_query text,
  p_embedding vector(384),
  p_anchor_ids text[],
  p_allowed_classifications text[],
  p_max_depth integer,
  p_limit integer
)
RETURNS TABLE (
  id text,
  node_id text,
  classification text,
  source_uri text,
  content text,
  score double precision,
  channels text[],
  rank_by_channel jsonb,
  graph_path text[]
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE
  scoped_chunks AS (
    SELECT chunk.*
    FROM knowledge_chunks AS chunk
    WHERE chunk.tenant_id = p_tenant_id
      AND current_setting('app.tenant_id', true) = p_tenant_id
      AND chunk.classification = ANY (p_allowed_classifications)
  ),
  reachable(node_id, depth, path) AS (
    SELECT anchor_id, 0, ARRAY[anchor_id]
    FROM unnest(p_anchor_ids) AS anchor_id
    UNION ALL
    SELECT neighbor.node_id, reachable.depth + 1, reachable.path || neighbor.node_id
    FROM reachable
    JOIN knowledge_edges AS edge
      ON edge.tenant_id = p_tenant_id
      AND (edge.source_id = reachable.node_id OR edge.target_id = reachable.node_id)
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN edge.source_id = reachable.node_id THEN edge.target_id
        ELSE edge.source_id
      END AS node_id
    ) AS neighbor
    WHERE reachable.depth < p_max_depth
      AND NOT neighbor.node_id = ANY (reachable.path)
  ),
  graph_candidates AS (
    SELECT DISTINCT ON (chunk.id)
      chunk.id,
      reachable.depth,
      reachable.path
    FROM scoped_chunks AS chunk
    JOIN reachable ON reachable.node_id = chunk.node_id
    ORDER BY chunk.id, reachable.depth, reachable.path
  ),
  keyword_ranked AS (
    SELECT
      chunk.id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.content_tsv, websearch_to_tsquery('english', p_query)) DESC,
                 chunk.id
      ) AS rank
    FROM scoped_chunks AS chunk
    WHERE chunk.content_tsv @@ websearch_to_tsquery('english', p_query)
  ),
  vector_ranked AS (
    SELECT
      chunk.id,
      row_number() OVER (ORDER BY chunk.embedding <=> p_embedding, chunk.id) AS rank
    FROM scoped_chunks AS chunk
    WHERE p_embedding IS NOT NULL AND chunk.embedding IS NOT NULL
  ),
  graph_ranked AS (
    SELECT
      candidate.id,
      row_number() OVER (ORDER BY candidate.depth, candidate.id) AS rank
    FROM graph_candidates AS candidate
  ),
  ranked AS (
    SELECT 'keyword'::text AS channel, id, rank, 1.0::double precision AS weight
    FROM keyword_ranked
    UNION ALL
    SELECT 'vector', id, rank, 1.0::double precision
    FROM vector_ranked
    UNION ALL
    SELECT 'graph', id, rank, 1.2::double precision
    FROM graph_ranked
  ),
  fused AS (
    SELECT
      ranked.id,
      sum(ranked.weight / (60.0 + ranked.rank))::double precision AS score,
      array_agg(DISTINCT ranked.channel ORDER BY ranked.channel) AS channels,
      jsonb_object_agg(ranked.channel, ranked.rank) AS rank_by_channel
    FROM ranked
    GROUP BY ranked.id
  )
  SELECT
    chunk.id,
    chunk.node_id,
    chunk.classification,
    chunk.source_uri,
    chunk.content,
    fused.score,
    fused.channels,
    fused.rank_by_channel,
    graph_candidates.path
  FROM fused
  JOIN scoped_chunks AS chunk ON chunk.id = fused.id
  LEFT JOIN graph_candidates ON graph_candidates.id = fused.id
  ORDER BY fused.score DESC, chunk.id
  LIMIT greatest(p_limit, 0);
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workflow_runs', 'run_events', 'approvals', 'idempotency_records',
    'tool_outbox', 'knowledge_nodes', 'knowledge_edges', 'knowledge_chunks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
