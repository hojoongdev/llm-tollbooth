import "server-only";

import { db } from "./mongo";

/**
 * The pricing table (spec §8.5).
 *
 * It is the only place a model's price lives — the gateway seeds it on first
 * boot and then only ever reads it, so an edit here re-prices every subsequent
 * call without a redeploy. It is also the gateway's routing table: the provider
 * on a row is who serves that model, because knowing the price already requires
 * knowing the vendor, and two lists would be one list too many to keep in sync.
 *
 * The gateway holds a 60-second snapshot of this table, so a change here takes
 * up to a minute to bite.
 */
export interface PriceRow {
  model: string;
  provider: string;
  inputPerMtok: number;
  outputPerMtok: number;
  updatedAt: Date | null;
}

const pricing = () => db().collection("provider_pricing");

export async function listPricing(): Promise<PriceRow[]> {
  const docs = await pricing().find().sort({ provider: 1, _id: 1 }).toArray();
  return docs.map((d) => ({
    model: String(d._id),
    provider: d.provider ?? "unknown",
    inputPerMtok: d.input_per_mtok ?? 0,
    outputPerMtok: d.output_per_mtok ?? 0,
    updatedAt: d.updated_at ?? null,
  }));
}

export async function upsertPrice(row: Omit<PriceRow, "updatedAt">): Promise<void> {
  await pricing().updateOne(
    { _id: row.model as never },
    {
      $set: {
        provider: row.provider,
        input_per_mtok: row.inputPerMtok,
        output_per_mtok: row.outputPerMtok,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );
}

/**
 * Deleting a price does not stop the model being callable — it stops it being
 * priceable. The gateway keeps metering it, at $0, and says so in its log.
 */
export async function deletePrice(model: string): Promise<void> {
  await pricing().deleteOne({ _id: model as never });
}
