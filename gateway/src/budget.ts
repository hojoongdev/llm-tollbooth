import type { FastifyBaseLogger } from "fastify";

import { cassandraReady, spendMicrosByDay } from "./cassandra.js";
import { BUDGET_RECONCILE_SECONDS, PROJECT_ID } from "./config.js";
import type { ApiKey } from "./keys.js";
import { collection } from "./mongo.js";

/**
 * Budget caps and rate limits — the "toll" half of the tollbooth (spec §4, group B).
 *
 * The hot path never asks Cassandra how much a key has spent today. It asks
 * memory. The gateway keeps its own running tally and a timer reconciles that
 * tally against `rollup_hourly`, which is authoritative because it is the number
 * the console shows: a budget enforced against a different tally than the one its
 * owner is watching would be a budget nobody could reason about.
 *
 * Reconciling takes the **maximum** of the two, never the stored value alone.
 * The rollup lags by up to one ingest flush, so a call we have already counted
 * locally may not have reached it yet — and assigning the lagging value would
 * hand the key its budget back. Taking the max means the lag can only ever make
 * us stricter. On restart the local tally is empty and the first reconcile seeds
 * it, which is why that reconcile happens *before* the server starts listening.
 *
 * Two known edges, both deliberate:
 *   - With Cassandra down, enforcement falls back to this process's own tally,
 *     which a restart resets. It fails open: an LLM proxy that stops answering
 *     because its bookkeeping store is unreachable has turned a reporting outage
 *     into an application outage. /health reports the degradation.
 *   - A second gateway instance would keep its own tally and its own token
 *     buckets. Single-node is the whole scope here (spec §12); sharing them would
 *     mean Redis.
 */

export interface Limits {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  rpm: number | null;
}

export interface Spend {
  dailyUsd: number;
  monthlyUsd: number;
}

export type BlockReason = "budget_exceeded" | "rate_limited";
export type Verdict = { allowed: true } | { allowed: false; reason: BlockReason; message: string };

const ALLOWED: Verdict = { allowed: true };

export const limitsOf = (key: ApiKey): Limits => ({
  dailyUsd: key.budget?.daily_usd ?? null,
  monthlyUsd: key.budget?.monthly_usd ?? null,
  rpm: key.rate_limit?.rpm ?? null,
});

// --------------------------------------------------------------------------- //
// The verdict (pure — spec §14 requires a unit test for this)
// --------------------------------------------------------------------------- //

/**
 * `>=`, not `>`: a key with a $5 daily budget and $5 spent has spent its budget.
 * Waiting for it to go strictly over would make the *last* call the one that
 * always breaks the cap.
 */
export function budgetVerdict(limits: Limits, spend: Spend): Verdict {
  if (limits.dailyUsd != null && spend.dailyUsd >= limits.dailyUsd) {
    return {
      allowed: false,
      reason: "budget_exceeded",
      message: `Daily budget of $${limits.dailyUsd} is spent for this key ($${spend.dailyUsd.toFixed(4)} used).`,
    };
  }
  if (limits.monthlyUsd != null && spend.monthlyUsd >= limits.monthlyUsd) {
    return {
      allowed: false,
      reason: "budget_exceeded",
      message: `Monthly budget of $${limits.monthlyUsd} is spent for this key ($${spend.monthlyUsd.toFixed(4)} used).`,
    };
  }
  return ALLOWED;
}

export interface Bucket {
  tokens: number;
  at: number;
}

/**
 * One token-bucket step: refill for the time elapsed, then try to spend a token.
 *
 * A bucket rather than a fixed window, because a fixed window lets a caller fire
 * a full minute's allowance at 11:59:59 and another at 12:00:00 — twice the limit
 * inside two seconds. The bucket refills continuously, so the limit holds across
 * *every* window, and it still permits a burst up to the full rpm after a quiet
 * spell, which is what callers actually expect.
 */
export function takeToken(bucket: Bucket, rpm: number, now: number): { bucket: Bucket; allowed: boolean } {
  const tokens = Math.min(rpm, bucket.tokens + ((now - bucket.at) / 60_000) * rpm);
  return tokens < 1
    ? { bucket: { tokens, at: now }, allowed: false }
    : { bucket: { tokens: tokens - 1, at: now }, allowed: true };
}

// --------------------------------------------------------------------------- //
// State
// --------------------------------------------------------------------------- //
interface Tally {
  day: string;
  daily: number;
  month: string;
  monthly: number;
}

const tallies = new Map<string, Tally>();
const buckets = new Map<string, Bucket>();

let log: FastifyBaseLogger;

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** The tally for this key, rolled over if the day or month has turned (UTC). */
function tallyFor(keyId: string): Tally {
  const day = dayKey();
  const month = monthKey();

  let t = tallies.get(keyId);
  if (!t) {
    t = { day, daily: 0, month, monthly: 0 };
    tallies.set(keyId, t);
  }
  if (t.day !== day) {
    t.day = day;
    t.daily = 0;
  }
  if (t.month !== month) {
    t.month = month;
    t.monthly = 0;
  }
  return t;
}

export function recordSpend(keyId: string, costUsd: number): void {
  if (costUsd <= 0) return;
  const t = tallyFor(keyId);
  t.daily += costUsd;
  t.monthly += costUsd;
}

export function spendOf(keyId: string): Spend {
  const t = tallyFor(keyId);
  return { dailyUsd: t.daily, monthlyUsd: t.monthly };
}

function rateVerdict(keyId: string, rpm: number | null): Verdict {
  if (rpm == null || rpm <= 0) return ALLOWED;

  const now = Date.now();
  const current = buckets.get(keyId) ?? { tokens: rpm, at: now };
  const { bucket, allowed } = takeToken(current, rpm, now);
  buckets.set(keyId, bucket);

  return allowed
    ? ALLOWED
    : {
        allowed: false,
        reason: "rate_limited",
        message: `Rate limit of ${rpm} requests/minute is exhausted for this key.`,
      };
}

/**
 * Budget before rate limit: a key that is out of money is out of money whatever
 * its pace, and checking the other way round would burn a token on a call we
 * were going to refuse anyway.
 */
export function checkLimits(key: ApiKey): Verdict {
  const limits = limitsOf(key);
  const budget = budgetVerdict(limits, spendOf(key._id));
  return budget.allowed ? rateVerdict(key._id, limits.rpm) : budget;
}

// --------------------------------------------------------------------------- //
// Reconciliation
// --------------------------------------------------------------------------- //
/** Every day of the current month up to today, UTC — the rollup partitions to read. */
function daysOfMonth(): string[] {
  const now = new Date();
  const days: string[] = [];
  for (let d = 1; d <= now.getUTCDate(); d++) {
    days.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d)).toISOString().slice(0, 10));
  }
  return days;
}

export async function reconcileBudgets(): Promise<void> {
  if (!cassandraReady()) return;

  const budgeted = await collection<ApiKey>("api_keys")
    .find({
      project_id: PROJECT_ID,
      $or: [{ "budget.daily_usd": { $ne: null } }, { "budget.monthly_usd": { $ne: null } }],
    })
    .toArray();

  await Promise.all(
    budgeted.map(async (key) => {
      // Only read the month when something is actually capped by the month.
      const needsMonth = key.budget?.monthly_usd != null;
      const byDay = await spendMicrosByDay(key._id, needsMonth ? daysOfMonth() : [dayKey()]);

      let monthlyMicros = 0;
      for (const micros of byDay.values()) monthlyMicros += micros;

      const t = tallyFor(key._id);
      t.daily = Math.max(t.daily, (byDay.get(dayKey()) ?? 0) / 1_000_000);
      t.monthly = Math.max(t.monthly, monthlyMicros / 1_000_000);
    }),
  );
}

export async function startBudgets(logger: FastifyBaseLogger): Promise<void> {
  log = logger;

  // Seed before we serve. A gateway that restarts must not hand every key a
  // fresh budget, which is exactly what an empty tally would do.
  await reconcileBudgets();

  setInterval(() => {
    void reconcileBudgets().catch((err) => log.warn({ err }, "budget reconcile failed"));
  }, BUDGET_RECONCILE_SECONDS * 1_000).unref();
}
