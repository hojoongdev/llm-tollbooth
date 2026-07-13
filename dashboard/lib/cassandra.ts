import "server-only";
import { Client, types } from "cassandra-driver";

import { PROJECT } from "./config";
import { daysInWindow, emptyBuckets, type Window } from "./time";

// Reuse one Client across requests (and across dev hot-reloads via globalThis),
// so we don't open a new connection pool per page render.
const g = globalThis as unknown as { __cass?: Client };

function client(): Client {
  if (!g.__cass) {
    g.__cass = new Client({
      contactPoints: (process.env.CASSANDRA_CONTACT_POINTS || "localhost").split(","),
      localDataCenter: process.env.CASSANDRA_DC || "datacenter1",
      keyspace: process.env.CASSANDRA_KEYSPACE || "tollbooth",
    });
  }
  return g.__cass;
}

/** Cassandra returns counters as Long; normalise everything to number. */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const maybe = v as { toNumber?: () => number };
  return typeof maybe.toNumber === "function" ? maybe.toNumber() : Number(v);
}

/**
 * Upper bounds of the rollup's latency histogram, in ms — the same ladder as the
 * lat_le_* counter columns, in the same order. This mirrors LATENCY_BUCKETS_MS in
 * the ingest worker; both are shadows of init.cql, where the ladder really lives.
 */
const LATENCY_BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const LATENCY_COLUMNS = LATENCY_BOUNDS_MS.map((b) => `lat_le_${b}`);

/**
 * Interpolate a percentile out of the cumulative `le` histogram.
 *
 * `hist[i]` counts the requests at or below LATENCY_BOUNDS_MS[i]. `total` is the
 * histogram's own denominator, `lat_count` — *not* `requests`, which counts rows
 * the histogram never saw (see init.cql). Find the bucket the target rank lands
 * in and assume its requests are spread evenly across it: the standard histogram
 * approximation, and the reason a bucket's width is the error bound on any
 * percentile inside it.
 *
 * Past the last bound there is nothing to interpolate against — an unbounded
 * bucket has no top. Returning the last bound is the honest floor ("at least this
 * slow"), and the ladder runs to 10s so that stays rare.
 */
function percentile(hist: number[], total: number, p: number): number {
  if (total <= 0) return 0;
  const rank = p * total;

  let lowerBound = 0;
  let lowerCount = 0;
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) {
    const count = hist[i];
    if (count >= rank) {
      const inBucket = count - lowerCount;
      if (inBucket <= 0) return lowerBound;
      return lowerBound + ((rank - lowerCount) / inBucket) * (LATENCY_BOUNDS_MS[i] - lowerBound);
    }
    lowerBound = LATENCY_BOUNDS_MS[i];
    lowerCount = count;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
}

export interface Totals {
  cost: number;
  requests: number;
  errors: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatency: number;
  p50: number;
  p95: number;
  p99: number;
  cacheHits: number;
  cacheHitRate: number;
}

export interface TrendPoint {
  ts: number; // epoch ms at bucket start
  cost: number;
  requests: number;
  errors: number;
  avgLatency: number;
}

export interface Overview {
  totals: Totals;
  trend: TrendPoint[];
}

interface Bucket {
  costMicros: number;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  latencySum: number;
  cacheHits: number;
  // Cumulative `le` counts, one per LATENCY_BOUNDS_MS entry. Summing them across
  // the window's hourly rows is plain column-wise addition, exactly like every
  // other counter here — which is the property cumulative buckets were chosen for.
  latencyHist: number[];
  // How many requests the histogram actually counted. Equal to `requests` for any
  // hour written since the buckets landed, and zero for the hours written before —
  // which is exactly why the percentiles divide by this and not by `requests`.
  latencyCount: number;
}

const empty = (): Bucket => ({
  costMicros: 0, requests: 0, errors: 0, promptTokens: 0,
  completionTokens: 0, latencySum: 0, cacheHits: 0,
  latencyHist: LATENCY_BOUNDS_MS.map(() => 0),
  latencyCount: 0,
});

function add(b: Bucket, row: Record<string, unknown>): void {
  b.costMicros += num(row.cost_micros);
  b.requests += num(row.requests);
  b.errors += num(row.errors);
  b.promptTokens += num(row.prompt_tokens);
  b.completionTokens += num(row.completion_tokens);
  b.latencySum += num(row.latency_sum_ms);
  b.cacheHits += num(row.cache_hits);
  b.latencyCount += num(row.lat_count);
  for (let i = 0; i < LATENCY_COLUMNS.length; i++) {
    b.latencyHist[i] += num(row[LATENCY_COLUMNS[i]]);
  }
}

/** The rollup rows for one breakdown axis over a window — the shared read. */
async function rollupRows(w: Window, dim: string) {
  const days = daysInWindow(w);
  const placeholders = days.map(() => "?").join(",");
  const params = [PROJECT, dim, ...days.map((d) => types.LocalDate.fromString(d))];
  const cql =
    "SELECT day, hour, cost_micros, requests, errors, prompt_tokens, " +
    `completion_tokens, latency_sum_ms, cache_hits, lat_count, ${LATENCY_COLUMNS.join(", ")} ` +
    "FROM rollup_hourly " +
    `WHERE project_id = ? AND dim = ? AND day IN (${placeholders})`;

  const res = await client().execute(cql, params, { prepare: true });
  return res.rows;
}

/** Totals only — the breakdown doesn't need a trend line drawn for every model. */
async function rollupTotals(w: Window, dim: string): Promise<Totals> {
  const totals = empty();
  const startHour = Math.floor(w.start.getTime() / 3_600_000) * 3_600_000;

  for (const row of await rollupRows(w, dim)) {
    const [y, m, d] = String(row.day).split("-").map(Number);
    const hourTs = Date.UTC(y, m - 1, d, num(row.hour));
    if (hourTs < startHour || hourTs > w.end.getTime()) continue;
    add(totals, row);
  }
  return summarize(totals);
}

/**
 * Read the pre-aggregated hourly rollup for one breakdown axis over a window.
 * Wide-range dashboard reads hit this table, never the raw per-request rows.
 */
export async function readRollup(w: Window, dim = "all"): Promise<Overview> {
  const res = { rows: await rollupRows(w, dim) };

  const unitStep = w.unit === "hour" ? 3_600_000 : 86_400_000;
  const floorBucket = (t: number) => Math.floor(t / unitStep) * unitStep;

  // Pre-seed continuous buckets so the trend line has no gaps.
  const series = new Map<number, Bucket>();
  for (const t of emptyBuckets(w)) series.set(t, empty());

  const totals = empty();
  const startHour = Math.floor(w.start.getTime() / 3_600_000) * 3_600_000;
  for (const row of res.rows) {
    const [y, m, d] = String(row.day).split("-").map(Number);
    const hourTs = Date.UTC(y, m - 1, d, num(row.hour));
    if (hourTs < startHour || hourTs > w.end.getTime()) continue;
    add(totals, row);
    const b = series.get(floorBucket(hourTs));
    if (b) add(b, row);
  }

  const trend: TrendPoint[] = [...series.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, b]) => ({
      ts,
      cost: b.costMicros / 1_000_000,
      requests: b.requests,
      errors: b.errors,
      avgLatency: b.requests ? b.latencySum / b.requests : 0,
    }));

  return { totals: summarize(totals), trend };
}

function summarize(b: Bucket): Totals {
  return {
    cost: b.costMicros / 1_000_000,
    requests: b.requests,
    errors: b.errors,
    errorRate: b.requests ? b.errors / b.requests : 0,
    promptTokens: b.promptTokens,
    completionTokens: b.completionTokens,
    totalTokens: b.promptTokens + b.completionTokens,
    avgLatency: b.requests ? b.latencySum / b.requests : 0,
    p50: percentile(b.latencyHist, b.latencyCount, 0.5),
    p95: percentile(b.latencyHist, b.latencyCount, 0.95),
    p99: percentile(b.latencyHist, b.latencyCount, 0.99),
    cacheHits: b.cacheHits,
    cacheHitRate: b.requests ? b.cacheHits / b.requests : 0,
  };
}

export interface ModelRow {
  model: string;
  provider: string | null;
  requests: number;
  errors: number;
  cost: number;
  tokens: number;
  avgLatency: number;
}

/**
 * Which models saw traffic in this window (dims_by_day) — a partition lookup per
 * day, not a scan.
 */
async function modelsSeen(w: Window): Promise<Map<string, string | null>> {
  const days = daysInWindow(w);
  const placeholders = days.map(() => "?").join(",");
  const cql =
    "SELECT value, provider FROM dims_by_day " +
    `WHERE project_id = ? AND day IN (${placeholders}) AND kind = ?`;
  const params = [PROJECT, ...days.map((d) => types.LocalDate.fromString(d)), "model"];

  const res = await client().execute(cql, params, { prepare: true });

  const seen = new Map<string, string | null>();
  for (const row of res.rows) seen.set(String(row.value), (row.provider as string) ?? null);
  return seen;
}

/**
 * Per-model breakdown over the window, most expensive first.
 *
 * Reads the rollup once per model that saw traffic — so its cost tracks the
 * number of *models*, not the number of requests. This used to be a Mongo
 * aggregation over the raw request documents, which was the one read path still
 * scanning raw data: fine at a few hundred rows, 1.8 seconds at 1.5M once the
 * P3 load test put that many in.
 */
export async function modelBreakdown(w: Window): Promise<ModelRow[]> {
  const seen = await modelsSeen(w);

  const rows = await Promise.all(
    [...seen].map(async ([model, provider]) => {
      const totals = await rollupTotals(w, `model:${model}`);
      return {
        model,
        provider,
        requests: totals.requests,
        errors: totals.errors,
        cost: totals.cost,
        tokens: totals.totalTokens,
        avgLatency: totals.avgLatency,
      };
    }),
  );

  // A model can be registered for the day but have no traffic inside a narrower
  // window (say the last hour) — those aren't a breakdown, they're noise.
  return rows.filter((r) => r.requests > 0).sort((a, b) => b.cost - a.cost);
}
