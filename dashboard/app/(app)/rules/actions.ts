"use server";

import { revalidatePath } from "next/cache";

import { METRICS, type Metric, type RuleAction } from "@/lib/rule-format";
import { armRule, createRule, deleteRule, setRuleEnabled, setRuleTuning } from "@/lib/rules";

export interface NewRuleState {
  ok?: string;
  error?: string;
}

function num(form: FormData, field: string, fallback: number): number {
  const n = Number(String(form.get(field) ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The action list, read off the checkboxes.
 *
 * Each type is its own checkbox with its own parameter next to it, so the form needs
 * no client state and degrades to plain HTML. A checked box with an empty parameter is
 * a mistake worth naming rather than silently dropping — an email alert with no
 * recipient is a rule that will look armed and tell nobody.
 */
function actionsFrom(form: FormData): { actions: RuleAction[]; error?: string } {
  const actions: RuleAction[] = [];

  if (form.get("use_email")) {
    const to = String(form.get("email_to") ?? "").trim();
    if (!to) return { actions, error: "Email is checked but has no recipient — who should hear about this?" };
    actions.push({ type: "email", to });
  }

  if (form.get("use_webhook")) {
    const url = String(form.get("webhook_url") ?? "").trim();
    if (!url) return { actions, error: "Webhook is checked but has no URL." };
    if (!/^https?:\/\//i.test(url)) return { actions, error: "The webhook URL needs to start with http:// or https://." };
    actions.push({ type: "webhook", url });
  }

  if (form.get("use_block")) actions.push({ type: "block" });

  if (form.get("use_tag")) {
    const tag = String(form.get("tag_value") ?? "").trim();
    if (!tag) return { actions, error: "Tag is checked but has no label." };
    actions.push({ type: "tag", tag });
  }

  return { actions };
}

export async function addRule(_prev: NewRuleState, form: FormData): Promise<NewRuleState> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name the rule — the firing history and the alert both lead with it." };

  const metric = String(form.get("metric") ?? "");
  if (!(METRICS as readonly string[]).includes(metric)) return { error: `Unknown metric: ${metric}` };

  const scope = String(form.get("scope") ?? "all");

  const threshold = num(form, "threshold", NaN);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return { error: "The threshold has to be a number, and not a negative one." };
  }

  const { actions, error } = actionsFrom(form);
  if (error) return { error };
  if (actions.length === 0) {
    // Not a technicality. A rule with no actions evaluates, trips, burns its cooldown
    // and tells nobody — it looks like it is watching, and it is not.
    return { error: "Pick at least one action. A rule with none fires into the void." };
  }

  // Cooldowns are entered in minutes because that is how people think about "don't
  // tell me again for a while"; the worker wants seconds.
  const cooldownMinutes = Math.max(0, num(form, "cooldown_minutes", 30));

  await createRule({
    name,
    scope,
    metric: metric as Metric,
    windowHours: num(form, "window_hours", 1),
    threshold,
    cooldownSeconds: Math.round(cooldownMinutes * 60),
    actions,
  });

  revalidatePath("/rules");
  return { ok: `"${name}" is armed.` };
}

export async function toggleRule(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  await setRuleEnabled(id, String(form.get("enabled")) !== "true");
  revalidatePath("/rules");
}

export async function tuneRule(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  await setRuleTuning(id, num(form, "threshold", 0), Math.round(num(form, "cooldown_minutes", 30) * 60));
  revalidatePath("/rules");
}

export async function rearmRule(form: FormData): Promise<void> {
  await armRule(String(form.get("id") ?? ""));
  revalidatePath("/rules");
}

export async function removeRule(form: FormData): Promise<void> {
  await deleteRule(String(form.get("id") ?? ""));
  revalidatePath("/rules");
}
