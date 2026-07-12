import type { FastifyBaseLogger } from "fastify";

import { collection } from "./mongo.js";
import type { Usage } from "./providers/types.js";

/**
 * What a call costs (spec §4): tokens × the model's price, from the Mongo
 * `provider_pricing` table. The table is the single source of truth — the
 * gateway only seeds rows it doesn't have — so re-pricing a model is a console
 * edit, not a redeploy.
 *
 * Prices are USD per *million* tokens because that is the unit every provider
 * publishes theirs in; the divide by 1e6 happens once, at multiplication.
 */
export interface Price {
  /** The model name — a call is priced by what it asked for. */
  _id: string;
  provider: string;
  input_per_mtok: number;
  output_per_mtok: number;
  updated_at?: Date;
}

const pricing = () => collection<Price>("provider_pricing");

// Seeded on first boot only ($setOnInsert), so a price edited in the console is
// never silently reverted by a restart. Same catalogue the loadgen uses, so
// synthetic and real gateway traffic price out consistently in one dashboard.
const SEED: Price[] = [
  { _id: "gpt-4o", provider: "openai", input_per_mtok: 2.5, output_per_mtok: 10.0 },
  { _id: "gpt-4o-mini", provider: "openai", input_per_mtok: 0.15, output_per_mtok: 0.6 },
  { _id: "claude-3-5-sonnet", provider: "anthropic", input_per_mtok: 3.0, output_per_mtok: 15.0 },
  { _id: "claude-3-5-haiku", provider: "anthropic", input_per_mtok: 0.8, output_per_mtok: 4.0 },
  { _id: "llama-3.1-8b", provider: "selfhost", input_per_mtok: 0.0, output_per_mtok: 0.0 },
];

let log: FastifyBaseLogger;

// The table is small and changes rarely, so the hot path reads a snapshot of it
// from memory and refreshes on a timer rather than querying Mongo per call.
const CACHE_TTL_MS = 60_000;
let cached: { at: number; byModel: Map<string, Price> } | null = null;

/** Models we've already warned about, so an unpriced model logs once, not per call. */
const warned = new Set<string>();

export async function initPricing(logger: FastifyBaseLogger): Promise<void> {
  log = logger;
  await pricing().bulkWrite(
    // `_id` is left out of $setOnInsert on purpose: on an upsert Mongo builds the
    // new document from the filter's equality terms, and naming the immutable
    // _id in the update as well is an error.
    SEED.map(({ _id, ...price }) => ({
      updateOne: {
        filter: { _id },
        update: { $setOnInsert: { ...price, updated_at: new Date() } },
        upsert: true,
      },
    })),
  );
  log.info({ models: SEED.length }, "pricing table ready");
}

async function table(): Promise<Map<string, Price>> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.byModel;

  const rows = await pricing().find().toArray();
  const byModel = new Map<string, Price>(rows.map((row) => [row._id, row]));
  cached = { at: now, byModel };
  return byModel;
}

/** Drops the snapshot so a console price edit takes effect at once. */
export function invalidatePricingCache(): void {
  cached = null;
}

/**
 * Pure, so the arithmetic can be tested without a database (spec §14 makes a
 * unit test for cost calculation mandatory).
 *
 * Multiply first, divide exactly once. Prices are quoted per *million* tokens,
 * so `tokens × price` is already the cost in micro-dollars — which happens to be
 * the unit the Cassandra rollup counters store, since they hold integers. Going
 * via dollars instead (tokens / 1e6 × price) forces the value through a binary
 * representation error on the way, and a cost that lands exactly on half a
 * micro-dollar then rounds the wrong way.
 */
export function computeCost(price: Price, usage: Usage): number {
  const micros =
    usage.prompt_tokens * price.input_per_mtok +
    usage.completion_tokens * price.output_per_mtok;
  return Math.round(micros) / 1_000_000;
}

/** Cost of one call. An unpriced model still gets metered — it just costs 0. */
export async function costOf(model: string, usage: Usage): Promise<number> {
  const price = (await table()).get(model);
  if (!price) {
    if (!warned.has(model)) {
      warned.add(model);
      log?.warn({ model }, "no price for model — recording it at $0; add it on the Pricing screen");
    }
    return 0;
  }
  return computeCost(price, usage);
}

/** Every model we know a price for — also what /v1/models advertises. */
export async function knownModels(): Promise<Price[]> {
  return [...(await table()).values()];
}
