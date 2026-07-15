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
--
-- The lat_le_* columns are a latency histogram. A mean hides exactly what an LLM
-- gateway needs to see — the tail — and p95 is also a rule condition (spec §4
-- group C), so it has to be readable straight from the rollup rather than
-- recomputed from raw rows.
--
-- Prometheus `le` semantics: each bucket counts the requests at or *below* its
-- bound, so the counts are cumulative and a percentile is found by scanning for
-- the bucket the target rank falls into. Cumulative buckets are additive, so
-- summing a window's worth of hourly rows is plain column-wise addition, exactly
-- like every other counter here.
--
-- `lat_count` is the histogram's own denominator — every request it counted,
-- including the ones past the last bound (its +Inf bucket). It looks redundant
-- next to `requests`, and for any row written since the histogram landed the two
-- are equal. It is not redundant, and this is the whole reason it exists: rows
-- written *before* the histogram have a `requests` count and no buckets at all.
-- Reading the denominator off `requests` would make every one of those pre-existing
-- requests look like it fell past the last bucket, and p99 would read 10s for as
-- long as the window still reaches back into them. A histogram has to carry its
-- own denominator, because the thing next to it was written by code that had never
-- heard of it.
--
-- The bounds are frozen into the column names, so re-cutting the ladder means an
-- ALTER TABLE. That is the price of p95 being a free by-product of a row the
-- dashboard already reads, and the ladder (10ms .. 10s) spans everything from a
-- cache hit to a slow completion, so it should not need re-cutting.
--
-- quality_sum / quality_count are the eval worker's territory (P5). Eval is
-- *sampled* — only a fraction of calls get scored by the judge LLM — so unlike
-- every counter above, quality_count is emphatically not `requests`: it is how
-- many calls were actually scored, and it is the average's honest denominator for
-- exactly the reason lat_count is. Scores are 1..5 and ride as score*100, so the
-- counter stays integer and the average keeps two decimals (cost_micros, again).
-- The eval worker UPDATEs these on the same (project, dim, day, hour) row the
-- ingest worker already writes — a second writer, disjoint columns, additive
-- counters, so no coordination is needed between them.
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
  lat_count counter,
  lat_le_10 counter,
  lat_le_25 counter,
  lat_le_50 counter,
  lat_le_100 counter,
  lat_le_250 counter,
  lat_le_500 counter,
  lat_le_1000 counter,
  lat_le_2500 counter,
  lat_le_5000 counter,
  lat_le_10000 counter,
  quality_sum counter,
  quality_count counter,
  PRIMARY KEY ((project_id, dim, day), hour)
);

-- The histogram columns again, as an explicit migration.
--
-- CREATE TABLE IF NOT EXISTS does not retrofit columns onto a table that already
-- exists, and cassandra-init replays this whole file on every `compose up` —
-- against a volume that usually already has a rollup_hourly in it. Without this,
-- the buckets would appear only on a fresh volume and the ingest worker would
-- crash writing to columns that aren't there. ADD IF NOT EXISTS makes it a no-op
-- on the fresh path, where the CREATE above already declared them.
ALTER TABLE rollup_hourly ADD IF NOT EXISTS (
  lat_count counter,
  lat_le_10 counter,
  lat_le_25 counter,
  lat_le_50 counter,
  lat_le_100 counter,
  lat_le_250 counter,
  lat_le_500 counter,
  lat_le_1000 counter,
  lat_le_2500 counter,
  lat_le_5000 counter,
  lat_le_10000 counter
);

-- The quality columns, same explicit migration for the same reason: a volume that
-- already holds a rollup_hourly from P1..P4 predates the eval worker, and the
-- CREATE above won't retrofit them. ADD IF NOT EXISTS is a no-op on a fresh volume.
ALTER TABLE rollup_hourly ADD IF NOT EXISTS (
  quality_sum counter,
  quality_count counter
);

-- Which breakdown axes actually saw traffic, per day.
--
-- rollup_hourly is partitioned by (project, dim, day). That makes reading *one*
-- dimension cheap, but leaves no way to discover which dimensions exist without
-- scanning the table — so the ingest worker writes them down here as it goes.
-- One small partition per (project, day), listing the models and keys seen.
--
-- This is the table that lets the dashboard's per-model breakdown be a handful
-- of rollup partition reads instead of an aggregation over every raw request
-- document. Without it the breakdown was O(traffic): fine at a few hundred rows,
-- and 1.8 seconds once a load test pushed 1.5M of them in — the one read path
-- that was still violating "wide queries never touch the raw tables".
CREATE TABLE IF NOT EXISTS dims_by_day (
  project_id text,
  day date,
  kind text,      -- 'model' | 'key'
  value text,     -- the model name, or the api key id
  provider text,  -- kind='model': who last served it. A label for the UI, not a key.
  PRIMARY KEY ((project_id, day), kind, value)
);
