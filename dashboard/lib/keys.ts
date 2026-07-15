import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { db } from "./mongo";

/**
 * API keys: the console issues them, the gateway verifies them (spec §4, group B).
 *
 * The two services never call each other — they meet in the `api_keys`
 * collection. That makes this document shape, *and the hash below*, the contract
 * between them: change how one side hashes a key and the other stops recognising
 * every key ever issued. Both sides therefore state it explicitly, and the E2E
 * check for this phase is literally "issue a key here, spend it there".
 *
 * (A shared workspace package is where this belongs eventually. Two functions
 * didn't justify restructuring both builds yet.)
 */
const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");
const generateKey = () => `tb_${randomBytes(24).toString("hex")}`;

/** null anywhere below means "no limit". */
export interface KeyLimits {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  rpm: number | null;
}

export interface KeyRow extends KeyLimits {
  id: string;
  name: string;
  prefix: string;
  status: "active" | "blocked";
  createdAt: Date;
}

const keys = () => db().collection("api_keys");

function toRow(d: Record<string, any>): KeyRow {
  return {
    id: String(d._id),
    name: d.name ?? "—",
    prefix: d.key_prefix ?? "",
    status: d.status === "blocked" ? "blocked" : "active",
    createdAt: d.created_at ?? new Date(0),
    dailyUsd: d.budget?.daily_usd ?? null,
    monthlyUsd: d.budget?.monthly_usd ?? null,
    rpm: d.rate_limit?.rpm ?? null,
  };
}

export async function listKeys(projectId: string): Promise<KeyRow[]> {
  const docs = await keys().find({ project_id: projectId }).sort({ created_at: -1 }).toArray();
  return docs.map(toRow);
}

/**
 * Mint a key and return it — the only moment it exists in readable form. What we
 * store is its hash, so a key that isn't copied off this screen is gone, and
 * "show me the key again" is a question nobody here can answer.
 */
export async function createKey(projectId: string, name: string, limits: KeyLimits): Promise<string> {
  const raw = generateKey();
  await keys().insertOne({
    _id: `key_${randomBytes(4).toString("hex")}` as never,
    name: name || "unnamed key",
    project_id: projectId,
    key_hash: hashKey(raw),
    // Enough to recognise the key in this table, not enough to use it.
    key_prefix: raw.slice(0, 12),
    status: "active",
    created_at: new Date(),
    budget: { daily_usd: limits.dailyUsd, monthly_usd: limits.monthlyUsd },
    rate_limit: { rpm: limits.rpm },
  });
  return raw;
}

// The mutations scope by project_id as well as _id — belt to the console's braces.
// The id only ever comes from a list this project already filtered, but a filter that
// includes the tenant means a forged id cannot touch another project's key even so.
export async function setKeyStatus(projectId: string, id: string, status: "active" | "blocked"): Promise<void> {
  await keys().updateOne({ _id: id as never, project_id: projectId }, { $set: { status } });
}

export async function setKeyLimits(projectId: string, id: string, limits: KeyLimits): Promise<void> {
  await keys().updateOne(
    { _id: id as never, project_id: projectId },
    {
      $set: {
        "budget.daily_usd": limits.dailyUsd,
        "budget.monthly_usd": limits.monthlyUsd,
        "rate_limit.rpm": limits.rpm,
      },
    },
  );
}

/** Revoking deletes the row: there is nothing to keep, since we never had the key. */
export async function deleteKey(projectId: string, id: string): Promise<void> {
  await keys().deleteOne({ _id: id as never, project_id: projectId });
}
