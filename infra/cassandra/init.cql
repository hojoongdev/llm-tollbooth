-- Cassandra schema for LLM Tollbooth metrics.
--
-- Cassandra is query-first: tables are shaped around the reads we need, not
-- normalized entities. Partition keys always include a `day` bucket so a single
-- partition can't grow without bound, and rows cluster by ts DESC so the most
-- recent events come back first.

CREATE KEYSPACE IF NOT EXISTS tollbooth
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

USE tollbooth;

-- Per-request rows, one partition per (project, model, day).
-- Read: "recent calls for model X today" -> one partition, already time-sorted.
CREATE TABLE IF NOT EXISTS metrics_by_model (
  project_id text,
  model text,
  day date,
  ts timestamp,
  event_id uuid,
  cost_usd double,
  prompt_tokens int,
  completion_tokens int,
  latency_ms int,
  status text,
  cache_hit boolean,
  PRIMARY KEY ((project_id, model, day), ts, event_id)
) WITH CLUSTERING ORDER BY (ts DESC, event_id ASC);

-- Same idea, partitioned by API key instead of model.
-- Read: "recent calls for key X today" (per-key drill-down, budget checks).
CREATE TABLE IF NOT EXISTS metrics_by_key (
  project_id text,
  api_key_id text,
  day date,
  ts timestamp,
  event_id uuid,
  cost_usd double,
  total_tokens int,
  latency_ms int,
  status text,
  PRIMARY KEY ((project_id, api_key_id, day), ts, event_id)
) WITH CLUSTERING ORDER BY (ts DESC, event_id ASC);

-- Pre-aggregated hourly rollup for dashboard trend charts. Wide-range queries
-- (24h / 7d / 30d) read this, never the raw tables above.
--
-- `dim` is the breakdown axis: 'all' | 'model:gpt-4o' | 'key:abc'. The ingest
-- worker increments these counters per event so charts stay cheap to read.
--
-- Counter columns are integer-only, so money is stored as micro-dollars
-- (cost_usd * 1_000_000) and divided back out at read time. Likewise latency is
-- summed as ms and divided by `requests` for an average. A counter table can
-- hold only the primary key plus counter columns — no regular columns allowed.
CREATE TABLE IF NOT EXISTS rollup_hourly (
  project_id text,
  dim text,
  day date,
  hour int,
  cost_micros counter,
  requests counter,
  errors counter,
  prompt_tokens counter,
  completion_tokens counter,
  latency_sum_ms counter,
  cache_hits counter,
  PRIMARY KEY ((project_id, dim, day), hour)
);
