"use server";

import { revalidatePath } from "next/cache";

import { readEvalSettings, writeEvalSettings } from "@/lib/eval";

export interface SettingsState {
  ok?: string;
  error?: string;
}

/** "a, b ,, c" -> ["a","b","c"]. Empty means "no filter", which means everything. */
function list(form: FormData, field: string): string[] {
  return String(form.get(field) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Write the eval settings the worker obeys.
 *
 * The worker re-reads this document every few seconds, so this takes effect without a
 * restart — which is the reason the settings live in Mongo rather than in the env that
 * seeds them.
 */
export async function saveEvalSettings(
  _prev: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const percent = Number(String(form.get("sample_percent") ?? "").trim());
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { error: "샘플링 비율은 0에서 100 사이여야 합니다." };
  }

  const evalModel = String(form.get("eval_model") ?? "").trim();
  if (!evalModel) {
    // With no judge there is nothing to ask, and the worker would score nothing at all.
    return { error: "평가에 쓸 모델 이름이 필요합니다." };
  }

  const current = await readEvalSettings();
  await writeEvalSettings({
    ...current,
    enabled: form.get("enabled") !== null,
    // Entered as a percentage because that is how people talk about sampling; the worker
    // wants a fraction.
    sampleRate: percent / 100,
    evalModel,
    models: list(form, "models"),
    keys: list(form, "keys"),
  });

  revalidatePath("/settings");
  revalidatePath("/quality");
  return {
    ok:
      percent === 0
        ? "저장했습니다 — 샘플링 0%라 새 호출은 채점되지 않습니다."
        : `저장했습니다 — 이제 호출의 ${percent}% 를 채점합니다.`,
  };
}
