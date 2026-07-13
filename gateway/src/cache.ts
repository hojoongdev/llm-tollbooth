import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

import { CACHE_TTL_SECONDS, PROJECT_ID } from "./config.js";
import { collection } from "./mongo.js";
import type { ChatRequest, ChatResponse } from "./providers/types.js";

/**
 * Response cache (spec §4, group B): the same question, to the same model, with
 * the same knobs, does not get paid for twice.
 *
 * Off by default. Caching quietly changes what an LLM call *means* — ask the
 * same thing twice at temperature 1 and you are meant to get two different
 * answers, and a cache gives you the first one again. That is a trade the
 * operator opts into (CACHE_TTL_SECONDS), not one we make for them.
 */
export interface CacheEntry {
  _id: string;
  model: string;
  response: ChatResponse;
  created_at: Date;
  /** TTL index field: Mongo deletes the row once this instant passes. */
  expires_at: Date;
}

const entries = () => collection<CacheEntry>("cache_entries");

export const cacheEnabled = (): boolean => CACHE_TTL_SECONDS > 0;

let log: FastifyBaseLogger;

export async function initCache(logger: FastifyBaseLogger): Promise<void> {
  log = logger;
  if (!cacheEnabled()) return;

  // expireAfterSeconds: 0 means "expire at the time in the field" — so the TTL is
  // baked into each row and changing CACHE_TTL_SECONDS doesn't need a new index.
  await entries().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  log.info({ ttl_seconds: CACHE_TTL_SECONDS }, "response cache enabled");
}

/**
 * The cache key: a hash of the request, normalized.
 *
 * Normalized, because two requests that differ only in how they were typed are
 * the same request — same messages with a trailing newline, fields serialized in
 * a different order. The canonical object is built field by field, in a fixed
 * order, rather than hashing the incoming JSON: that is what makes key order
 * irrelevant, and it also means an unknown field a client tacks on can never
 * silently fragment the cache.
 *
 * Everything that changes the answer is in the key (model, messages,
 * temperature, top_p, max_tokens, stop). Everything that doesn't is out
 * (feature_tag is a label for us, not an instruction to the model).
 *
 * project_id is in the key too. Nothing shares a project today, but a cache that
 * can hand one tenant's answer to another is a leak waiting for P6 to arrive.
 */
export function cacheKey(chat: ChatRequest): string {
  const canonical = {
    project: PROJECT_ID,
    model: chat.model.trim(),
    messages: chat.messages.map((m) => ({
      role: m.role,
      content: (m.content ?? "").trim(),
      ...(m.name ? { name: m.name } : {}),
    })),
    temperature: chat.temperature ?? null,
    top_p: chat.top_p ?? null,
    max_tokens: chat.max_tokens ?? null,
    stop: chat.stop ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * A findOne on an indexed _id — the one synchronous database read we allow on
 * the hot path, because the thing it saves is an entire LLM call. A miss costs
 * a millisecond; a hit saves a second and the money.
 */
export async function cacheGet(key: string): Promise<ChatResponse | null> {
  if (!cacheEnabled()) return null;

  try {
    const hit = await entries().findOne({ _id: key });
    // Mongo's TTL reaper runs about once a minute, so a row can outlive its
    // expiry by up to that long. Check the time ourselves rather than serve it.
    if (!hit || hit.expires_at.getTime() <= Date.now()) return null;
    return hit.response;
  } catch (err) {
    // A broken cache must never break a call — fall through and ask the provider.
    log.warn({ err }, "cache lookup failed");
    return null;
  }
}

/** Fire-and-forget, like every other thing we record: the caller has their answer. */
export function cachePut(key: string, chat: ChatRequest, response: ChatResponse): void {
  if (!cacheEnabled()) return;

  const now = Date.now();
  entries()
    .updateOne(
      { _id: key },
      {
        $set: {
          model: chat.model,
          response,
          created_at: new Date(now),
          expires_at: new Date(now + CACHE_TTL_SECONDS * 1_000),
        },
      },
      { upsert: true },
    )
    .catch((err) => log.warn({ err }, "cache write failed"));
}
