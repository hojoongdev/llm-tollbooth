"use server";

import { revalidatePath } from "next/cache";

import { deletePrice, upsertPrice } from "@/lib/pricing";

export interface PriceState {
  error?: string;
  saved?: string;
}

function money(form: FormData, field: string): number {
  const n = Number(String(form.get(field) ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function savePrice(_prev: PriceState, form: FormData): Promise<PriceState> {
  const model = String(form.get("model") ?? "").trim();
  const provider = String(form.get("provider") ?? "").trim();
  if (!model) return { error: "A model needs a name." };
  if (!provider) return { error: "A model needs a provider — that is also who the gateway routes it to." };

  await upsertPrice({
    model,
    provider,
    inputPerMtok: money(form, "inputPerMtok"),
    outputPerMtok: money(form, "outputPerMtok"),
  });
  revalidatePath("/pricing");
  return { saved: model };
}

/** The row forms, which don't need to report anything back. */
export async function updatePrice(form: FormData): Promise<void> {
  await savePrice({}, form);
}

export async function removePrice(form: FormData): Promise<void> {
  await deletePrice(String(form.get("model") ?? ""));
  revalidatePath("/pricing");
}
