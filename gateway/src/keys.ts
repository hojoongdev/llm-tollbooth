import { createHash, randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

import { AUTH_MODE, DEFAULT_KEY, PROJECT_ID } from "./config.js";
import { collection } from "./mongo.js";

export interface ApiKey {
  /** The key id — this is what rides on every event as `api_key_id`. */
  _id: string;
  name: string;
  project_id: string;
  /** SHA-256 of the raw key. The raw key itself is never stored, anywhere. */
  key_hash: string;
  /** Leading characters, so the console can tell keys apart without holding one. */
  key_prefix: string;
  status: "active" | "blocked";
  created_at: Date;
  // Set from the console; enforced here (budget.ts). Absent or null = no limit.
  budget?: { daily_usd: number | null; monthly_usd: number | null };
  rate_limit?: { rpm: number | null };
}

const keys = () => collection<ApiKey>("api_keys");

/**
 * A plain SHA-256, deliberately — not bcrypt/argon2.
 *
 * Slow password hashes exist because passwords are low-entropy and guessable. An
 * API key here is 24 random bytes: there is nothing to guess, so the slowness
 * would buy no security. And this hash runs on *every* call through the gateway,
 * where it would buy real latency instead.
 */
export const hashKey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

export const generateKey = (): string => `tb_${randomBytes(24).toString("hex")}`;

// --------------------------------------------------------------------------- //
// Hot-path lookup
// --------------------------------------------------------------------------- //
// Every request has to resolve a key, and a Mongo round-trip per request is
// exactly the kind of synchronous DB hit the hot path is supposed to avoid
// (spec §14 allows a short-TTL cache of key state for this reason). The cost is
// that a key revoked in the console keeps working for up to TTL seconds.
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 10_000;

const cache = new Map<string, { key: ApiKey | null; expires: number }>();

export async function lookupKey(raw: string): Promise<ApiKey | null> {
  const hash = hashKey(raw);
  const now = Date.now();

  const hit = cache.get(hash);
  if (hit && hit.expires > now) return hit.key;

  const key = await keys().findOne({ key_hash: hash });

  // Misses are cached too: without that, anyone spraying random keys gets a free
  // Mongo query per attempt. Bound the map so that spraying can't grow it either.
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(hash, { key, expires: now + CACHE_TTL_MS });
  return key;
}

/** Drops the cache so a console change (revoke, block) takes effect at once. */
export function invalidateKeyCache(): void {
  cache.clear();
}

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //
export async function initKeys(log: FastifyBaseLogger): Promise<void> {
  // Lookups are by hash, so that is the index that matters.
  await keys().createIndex({ key_hash: 1 }, { unique: true });
  await ensureDefaultKey(log);
}

/**
 * With AUTH_MODE=none nobody logs into the console to issue a key — but the
 * gateway still demands one (spec §6). So it mints one itself and prints it.
 *
 * Unpinned, a fresh key is minted on every boot: we only ever store the hash, so
 * yesterday's key is genuinely unrecoverable and printing a stale one would be a
 * lie. Set GATEWAY_DEFAULT_KEY to pin a value across restarts instead.
 */
async function ensureDefaultKey(log: FastifyBaseLogger): Promise<void> {
  if (AUTH_MODE !== "none") return;

  const raw = DEFAULT_KEY || generateKey();
  await keys().updateOne(
    { _id: "key_default" },
    {
      $set: {
        key_hash: hashKey(raw),
        key_prefix: raw.slice(0, 12),
        status: "active",
      },
      $setOnInsert: {
        name: "default (AUTH_MODE=none)",
        project_id: PROJECT_ID,
        created_at: new Date(),
      },
    },
    { upsert: true },
  );
  invalidateKeyCache();

  // Deliberately a warning, not an info line. Running on a key the gateway minted
  // for itself *is* something to be warned about — and it means raising LOG_LEVEL
  // to quiet the per-request logs (as a load test does) can't hide the one line
  // you need to make any call at all.
  log.warn(
    { key: raw, pinned: Boolean(DEFAULT_KEY) },
    "AUTH_MODE=none — demo API key (local demos only; issue keys from the console " +
      "for anything exposed, or pin this one with GATEWAY_DEFAULT_KEY)",
  );
}
