"use server";

import { revalidatePath } from "next/cache";

import {
  BUDGET_PERIODS,
  CONDITIONS,
  KEYWORD_TARGETS,
  METRICS,
  type BudgetPeriod,
  type ConditionKind,
  type KeywordTarget,
  type Metric,
  type RuleAction,
} from "@/lib/rule-format";
import { armRule, createRule, deleteRule, setRuleEnabled, setRuleTuning, type NewRule } from "@/lib/rules";

export interface NewRuleState {
  ok?: string;
  error?: string;
}

function num(form: FormData, field: string, fallback: number): number {
  const n = Number(String(form.get(field) ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  (allowed as readonly string[]).includes(v as string) ? (v as T) : fallback;

/**
 * The action list, read off the checkboxes.
 *
 * Each type is its own checkbox with its own parameter next to it, so the form needs no
 * client state for them and degrades to plain HTML. A checked box with an empty parameter is
 * a mistake worth naming rather than silently dropping — an email alert with no recipient is
 * a rule that will look armed and tell nobody.
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

/** The half of the rule that depends on which question it is asking. */
function conditionFrom(
  form: FormData,
  kind: ConditionKind,
  scope: string,
): { fields: Partial<NewRule>; error?: string } {
  if (kind === "budget_percent") {
    // A budget belongs to a key. 'all traffic' has no cap to be a percentage of, so the
    // rule could never be evaluated — better to say so here than to let the worker skip it
    // silently forever.
    if (!scope.startsWith("key:")) {
      return { fields: {}, error: "A budget rule has to watch one API key — 'all traffic' has no budget to be a percentage of." };
    }
    const percent = num(form, "percent", NaN);
    if (!Number.isFinite(percent) || percent <= 0) {
      return { fields: {}, error: "The budget percentage has to be a positive number." };
    }
    return {
      fields: { period: oneOf<BudgetPeriod>(BUDGET_PERIODS, form.get("period"), "daily"), percent },
    };
  }

  if (kind === "keyword_match") {
    const keyword = String(form.get("keyword") ?? "").trim();
    if (!keyword) {
      // The empty string is in every request ever made.
      return { fields: {}, error: "Give the rule a keyword to look for." };
    }
    return {
      fields: {
        keyword,
        matchedIn: oneOf<KeywordTarget>(KEYWORD_TARGETS, form.get("matched_in"), "either"),
      },
    };
  }

  if (kind === "quality_drop") {
    const minScore = num(form, "min_score", NaN);
    // Scores are 1..5 by construction (the judge's rubric), so a floor outside that is a
    // rule that can never fire, or one that always does.
    if (!Number.isFinite(minScore) || minScore <= 1 || minScore > 5) {
      return { fields: {}, error: "Quality is scored 1–5, so the floor has to sit above 1 and at most 5." };
    }
    const minSamples = num(form, "min_samples", NaN);
    if (!Number.isFinite(minSamples) || minSamples < 1) {
      return { fields: {}, error: "The rule needs at least one scored call before it can average anything." };
    }
    return {
      fields: { minScore, minSamples: Math.round(minSamples), windowHours: num(form, "window_hours", 24) },
    };
  }

  const metric = oneOf<Metric>(METRICS, form.get("metric"), "cost");
  const threshold = num(form, "threshold", NaN);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return { fields: {}, error: "The threshold has to be a number, and not a negative one." };
  }
  return { fields: { metric, windowHours: num(form, "window_hours", 1), threshold } };
}

export async function addRule(_prev: NewRuleState, form: FormData): Promise<NewRuleState> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name the rule — the firing history and the alert both lead with it." };

  const kind = oneOf<ConditionKind>(CONDITIONS, form.get("kind"), "metric_threshold");
  const scope = String(form.get("scope") ?? "all");

  const { fields, error: conditionError } = conditionFrom(form, kind, scope);
  if (conditionError) return { error: conditionError };

  const { actions, error: actionError } = actionsFrom(form);
  if (actionError) return { error: actionError };
  if (actions.length === 0) {
    // Not a technicality. A rule with no actions evaluates, trips, burns its cooldown and
    // tells nobody — it looks like it is watching, and it is not.
    return { error: "Pick at least one action. A rule with none fires into the void." };
  }

  // Cooldowns are entered in minutes because that is how people think about "don't tell me
  // again for a while"; the worker wants seconds.
  const cooldownMinutes = Math.max(0, num(form, "cooldown_minutes", 30));

  await createRule({
    name,
    scope,
    kind,
    cooldownSeconds: Math.round(cooldownMinutes * 60),
    actions,
    ...fields,
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
  const kind = oneOf<ConditionKind>(CONDITIONS, form.get("kind"), "metric_threshold");
  await setRuleTuning(
    id,
    kind,
    num(form, "value", 0),
    Math.round(num(form, "cooldown_minutes", 30) * 60),
  );
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
