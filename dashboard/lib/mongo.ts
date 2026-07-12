import "server-only";
import { MongoClient, type Db } from "mongodb";

import { PROJECT } from "./config";
import type { Window } from "./time";

const g = globalThis as unknown as { __mongo?: MongoClient };

function db(): Db {
  if (!g.__mongo) {
    g.__mongo = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017");
  }
  return g.__mongo.db(process.env.MONGO_DB || "tollbooth");
}

// Anything not success/cached counts as an error (matches the ingest worker).
const OK = ["success", "cached"];
const isErrorExpr = { $cond: [{ $in: ["$status", OK] }, 0, 1] };

export interface ModelRow {
  model: string;
  provider: string | null;
  requests: number;
  errors: number;
  cost: number;
  tokens: number;
  avgLatency: number;
}

/** Per-model breakdown over the window, most expensive first. */
export async function modelBreakdown(w: Window): Promise<ModelRow[]> {
  const rows = await db()
    .collection("requests")
    .aggregate([
      { $match: { project_id: PROJECT, ts: { $gte: w.start, $lte: w.end } } },
      {
        $group: {
          _id: "$model",
          provider: { $first: "$provider" },
          requests: { $sum: 1 },
          errors: { $sum: isErrorExpr },
          cost: { $sum: "$cost_usd" },
          tokens: { $sum: "$total_tokens" },
          latency: { $sum: "$latency_ms" },
        },
      },
      { $sort: { cost: -1 } },
    ])
    .toArray();

  return rows.map((r) => ({
    model: r._id ?? "unknown",
    provider: r.provider ?? null,
    requests: r.requests,
    errors: r.errors,
    cost: r.cost ?? 0,
    tokens: r.tokens ?? 0,
    avgLatency: r.requests ? r.latency / r.requests : 0,
  }));
}

export interface RequestRow {
  id: string;
  ts: Date;
  provider: string | null;
  model: string;
  apiKeyId: string;
  status: string;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  latencyMs: number;
  ttfbMs: number | null;
  errorType: string | null;
  featureTag: string | null;
  endpoint: string | null;
}

export interface RequestFilter {
  window: Window;
  model?: string;
  status?: string;
  limit?: number;
}

function toRow(d: Record<string, any>): RequestRow {
  return {
    id: String(d._id),
    ts: d.ts,
    provider: d.provider ?? null,
    model: d.model ?? "unknown",
    apiKeyId: d.api_key_id ?? "unknown",
    status: d.status ?? "unknown",
    cacheHit: !!d.cache_hit,
    promptTokens: d.prompt_tokens ?? 0,
    completionTokens: d.completion_tokens ?? 0,
    totalTokens: d.total_tokens ?? 0,
    cost: d.cost_usd ?? 0,
    latencyMs: d.latency_ms ?? 0,
    ttfbMs: d.ttfb_ms ?? null,
    errorType: d.error_type ?? null,
    featureTag: d.feature_tag ?? null,
    endpoint: d.endpoint ?? null,
  };
}

/** Recent request log for the table, newest first. */
export async function listRequests(f: RequestFilter): Promise<RequestRow[]> {
  const q: Record<string, unknown> = {
    project_id: PROJECT,
    ts: { $gte: f.window.start, $lte: f.window.end },
  };
  if (f.model) q.model = f.model;
  if (f.status) q.status = f.status;

  const docs = await db()
    .collection("requests")
    .find(q)
    .sort({ ts: -1 })
    .limit(f.limit ?? 100)
    .toArray();

  return docs.map(toRow);
}

export async function getRequest(id: string): Promise<RequestRow | null> {
  const doc = await db().collection("requests").findOne({ _id: id as never });
  return doc ? toRow(doc) : null;
}
