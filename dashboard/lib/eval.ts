import "server-only";

import { db } from "./mongo";

/**
 * Quality evaluation: the settings the eval worker obeys, and the scores it wrote
 * (spec §4 group D).
 *
 * As with rules and api_keys, the console and the worker never call each other — they meet
 * in a Mongo document, which makes its shape the contract between them. The worker re-reads
 * `settings/_id: "eval"` every few seconds, so a change made here arms without a restart,
 * and the snake_case is not incidental: the worker is Python and reads exactly these names.
 *
 * The scores themselves live embedded on the request documents (`requests.eval`), written by
 * the worker under the same _id the gateway and the ingest worker write their halves under.
 * Three writers, one document, disjoint fields, every one of them a $set — so they converge
 * in any order.
 */

const settings = () => db().collection("settings");
const requests = () => db().collection("requests");

export interface EvalSettings {
  enabled: boolean;
  /** 0–1. Whole-corpus evaluation costs a judge call per request, hence sampling. */
  sampleRate: number;
  /** The judge. With no provider key configured this is answered by the mock. */
  evalModel: string;
  /** Empty = every model / every key. */
  models: string[];
  keys: string[];
}

const DEFAULTS: EvalSettings = {
  enabled: true,
  sampleRate: 0.1,
  evalModel: "gpt-4o-mini",
  models: [],
  keys: [],
};

/**
 * The worker seeds this document at boot, so it normally exists. Defaults here are for the
 * window before the worker has ever run — the screen should render, not crash, and it should
 * show what the worker *would* do.
 */
export async function readEvalSettings(): Promise<EvalSettings> {
  const d = (await settings().findOne({ _id: "eval" as never })) as Record<string, unknown> | null;
  if (!d) return DEFAULTS;
  return {
    enabled: d.enabled !== false,
    sampleRate: Number(d.sample_rate ?? DEFAULTS.sampleRate),
    evalModel: String(d.eval_model ?? DEFAULTS.evalModel),
    models: Array.isArray(d.models) ? (d.models as string[]) : [],
    keys: Array.isArray(d.keys) ? (d.keys as string[]) : [],
  };
}

export async function writeEvalSettings(s: EvalSettings): Promise<void> {
  await settings().updateOne(
    { _id: "eval" as never },
    {
      $set: {
        enabled: s.enabled,
        sample_rate: s.sampleRate,
        eval_model: s.evalModel,
        models: s.models,
        keys: s.keys,
      },
    },
    { upsert: true },
  );
}

export interface ScoredRow {
  id: string;
  ts: Date;
  model: string;
  /** 1–5, higher is better. hallucination_risk is inverted into it (the worker does that). */
  overall: number;
  relevance: number;
  hallucinationRisk: number;
  tone: number;
  reason: string;
  /** The judge that scored it — not the model that was scored. */
  judge: string;
  prompt: string;
}

/**
 * The most recently scored calls, worst first.
 *
 * Worst first, not newest first, and that is the whole reason to have this list: a quality
 * screen exists to show you the answers you would not have gone looking for. Sorting by time
 * would put the most recent 4.7 at the top and bury the 1.3 that is the reason someone
 * opened the page.
 *
 * `eval.overall` is an embedded field on a document the TTL index already ages out, so this
 * is bounded by the same retention as everything else. The window keeps it a small scan
 * rather than a growing one.
 */
export async function listScored(since: Date, limit = 20): Promise<ScoredRow[]> {
  const docs = await requests()
    .find({ ts: { $gte: since }, "eval.overall": { $exists: true } })
    .sort({ "eval.overall": 1, ts: -1 })
    .limit(limit)
    .toArray();

  return docs.map((d: Record<string, any>) => ({
    id: String(d._id),
    ts: d.ts ?? new Date(0),
    model: d.model ?? "—",
    overall: Number(d.eval?.overall ?? 0),
    relevance: Number(d.eval?.relevance ?? 0),
    hallucinationRisk: Number(d.eval?.hallucination_risk ?? 0),
    tone: Number(d.eval?.tone ?? 0),
    reason: String(d.eval?.reason ?? ""),
    judge: String(d.eval?.model ?? "—"),
    prompt: firstUserTurn(d),
  }));
}

/** Enough of the prompt to recognise the call, without opening it. */
function firstUserTurn(d: Record<string, any>): string {
  const messages = d.request?.messages ?? [];
  const user = [...messages].reverse().find((m: { role: string }) => m.role === "user");
  return String(user?.content ?? "").slice(0, 120);
}
