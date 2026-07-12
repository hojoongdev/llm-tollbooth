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

export interface Totals {
  cost: number;
  requests: number;
  errors: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatency: number;
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
}

const empty = (): Bucket => ({
  costMicros: 0, requests: 0, errors: 0, promptTokens: 0,
  completionTokens: 0, latencySum: 0, cacheHits: 0,
});

function add(b: Bucket, row: Record<string, unknown>): void {
  b.costMicros += num(row.cost_micros);
  b.requests += num(row.requests);
  b.errors += num(row.errors);
  b.promptTokens += num(row.prompt_tokens);
  b.completionTokens += num(row.completion_tokens);
  b.latencySum += num(row.latency_sum_ms);
  b.cacheHits += num(row.cache_hits);
}

/** The rollup rows for one breakdown axis over a window — the shared read. */
async function rollupRows(w: Window, dim: string) {
  const days = daysInWindow(w);
  const placeholders = days.map(() => "?").join(",");
  const params = [PROJECT, dim, ...days.map((d) => types.LocalDate.fromString(d))];
  const cql =
    "SELECT day, hour, cost_micros, requests, errors, prompt_tokens, " +
    "completion_tokens, latency_sum_ms, cache_hits FROM rollup_hourly " +
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
