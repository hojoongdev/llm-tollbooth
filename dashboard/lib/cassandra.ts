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

/**
 * Read the pre-aggregated hourly rollup for one breakdown axis over a window.
 * Wide-range dashboard reads hit this table, never the raw per-request rows.
 */
export async function readRollup(w: Window, dim = "all"): Promise<Overview> {
  const days = daysInWindow(w);
  const placeholders = days.map(() => "?").join(",");
  const params = [PROJECT, dim, ...days.map((d) => types.LocalDate.fromString(d))];
  const cql =
    "SELECT day, hour, cost_micros, requests, errors, prompt_tokens, " +
    "completion_tokens, latency_sum_ms, cache_hits FROM rollup_hourly " +
    `WHERE project_id = ? AND dim = ? AND day IN (${placeholders})`;

  const res = await client().execute(cql, params, { prepare: true });

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
