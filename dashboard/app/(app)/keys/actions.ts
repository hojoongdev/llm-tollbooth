"use server";

import { revalidatePath } from "next/cache";

import { createKey, deleteKey, setKeyLimits, setKeyStatus, type KeyLimits } from "@/lib/keys";

export interface NewKeyState {
  /** The raw key, returned exactly once — the screen shows it and forgets it. */
  key?: string;
  error?: string;
}

/** An empty field means "no limit". Zero would mean "allow nothing", so don't conflate them. */
function limit(form: FormData, field: string): number | null {
  const raw = String(form.get(field) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const limitsFrom = (form: FormData): KeyLimits => ({
  dailyUsd: limit(form, "dailyUsd"),
  monthlyUsd: limit(form, "monthlyUsd"),
  rpm: limit(form, "rpm"),
});

export async function issueKey(_prev: NewKeyState, form: FormData): Promise<NewKeyState> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name the key — it's the only way to tell it apart later." };

  const key = await createKey(name, limitsFrom(form));
  revalidatePath("/keys");
  return { key };
}

export async function toggleKey(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  const blocked = String(form.get("status")) === "blocked";
  await setKeyStatus(id, blocked ? "active" : "blocked");
  revalidatePath("/keys");
}

export async function updateLimits(form: FormData): Promise<void> {
  await setKeyLimits(String(form.get("id") ?? ""), limitsFrom(form));
  revalidatePath("/keys");
}

export async function revokeKey(form: FormData): Promise<void> {
  await deleteKey(String(form.get("id") ?? ""));
  revalidatePath("/keys");
}
