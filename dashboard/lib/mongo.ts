import "server-only";
import { MongoClient, type Db } from "mongodb";

import type { Window } from "./time";

const g = globalThis as unknown as { __mongo?: MongoClient };

export function db(): Db {
  if (!g.__mongo) {
    g.__mongo = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017");
  }
  return g.__mongo.db(process.env.MONGO_DB || "tollbooth");
}

// Mongo answers the questions that need a *document* — the request log and its
// detail. Anything that aggregates over many requests reads the Cassandra
// rollups instead (see lib/cassandra.ts): the whole point of writing those
// counters is never having to scan these documents to count something.

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
  projectId: string;
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
    project_id: f.projectId,
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

/** The eval worker's verdict on this call, embedded on the request (spec §4 group D). */
export interface RequestEval {
  overall: number;
  relevance: number;
  hallucinationRisk: number;
  tone: number;
  reason: string;
  /** The judge model — not the model being judged. */
  judge: string;
  scoredAt: Date | null;
}

export interface RequestDetail extends RequestRow {
  /** The prompt, as sent. Null for synthetic loadgen events, which carry no bodies. */
  messages: Array<{ role: string; content: string }> | null;
  answer: string | null;
  error: string | null;
  /** Null unless this call was sampled for evaluation — most are not. */
  evaluation: RequestEval | null;
  /** A non-error annotation, e.g. that the call fell back to another model. */
  note: string | null;
}

/**
 * One request, metrics *and* bodies.
 *
 * Two writers fill this document: the gateway stores the prompt/response the
 * moment the call ends, the ingest worker merges the metrics in when it flushes
 * its batch. Either can be the one that hasn't landed yet, so every field here
 * is treated as optional.
 */
export async function getRequest(projectId: string, id: string): Promise<RequestDetail | null> {
  // project_id is in the filter, not checked after the read, and that is the whole
  // point: a request from another tenant must be *not found*, not found-then-hidden.
  // Without it, anyone who knows (or guesses) an event id could open the prompt and
  // response of a call in someone else's project by visiting /requests/<id>.
  const doc = await db().collection("requests").findOne({ _id: id as never, project_id: projectId });
  if (!doc) return null;

  const e = doc.eval;
  return {
    ...toRow(doc),
    messages: doc.request?.messages ?? null,
    answer: doc.response?.content ?? null,
    error: doc.error ?? null,
    // A fourth writer on this document (gateway, ingest, rules, eval), and like the others
    // it $sets one field nobody else touches.
    evaluation: e
      ? {
          overall: Number(e.overall ?? 0),
          relevance: Number(e.relevance ?? 0),
          hallucinationRisk: Number(e.hallucination_risk ?? 0),
          tone: Number(e.tone ?? 0),
          reason: String(e.reason ?? ""),
          judge: String(e.model ?? "—"),
          scoredAt: e.scored_at ?? null,
        }
      : null,
    note: doc.note ?? null,
  };
}
