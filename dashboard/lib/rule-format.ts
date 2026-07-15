/**
 * The rule vocabulary, and how to print it.
 *
 * Split out of lib/rules.ts because that file is "server-only" — it talks to Mongo —
 * and the client components that render a rule need these *values*, not just their
 * types. A client component importing a value from a server-only module fails the
 * build, which is the guard working as intended.
 */

import { count, ms, pct, usd } from "./format";

/** Four conditions, and they are not the same shape (spec §4 group C). */
export const CONDITIONS = [
  "metric_threshold",
  "budget_percent",
  "keyword_match",
  "quality_drop",
] as const;
export type ConditionKind = (typeof CONDITIONS)[number];

export const CONDITION_LABEL: Record<ConditionKind, string> = {
  metric_threshold: "Metric over a threshold",
  budget_percent: "Budget % reached",
  keyword_match: "Keyword in a call",
  quality_drop: "Quality below a score",
};

export const METRICS = ["cost", "tokens", "latency_p95", "error_rate", "request_count"] as const;
export type Metric = (typeof METRICS)[number];

/** What the threshold input is asking for, in the unit the metric is measured in. */
export const METRIC_UNIT: Record<Metric, string> = {
  cost: "USD",
  tokens: "tokens",
  latency_p95: "ms",
  error_rate: "0–1",
  request_count: "count",
};

export const METRIC_LABEL: Record<Metric, string> = {
  cost: "Cost",
  tokens: "Tokens",
  latency_p95: "Latency p95",
  error_rate: "Error rate",
  request_count: "Requests",
};

export const BUDGET_PERIODS = ["daily", "monthly"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const KEYWORD_TARGETS = ["either", "prompt", "response"] as const;
export type KeywordTarget = (typeof KEYWORD_TARGETS)[number];

export const KEYWORD_TARGET_LABEL: Record<KeywordTarget, string> = {
  either: "Prompt or response",
  prompt: "Prompt only",
  response: "Response only",
};

export const ACTION_TYPES = ["email", "webhook", "block", "tag"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface RuleAction {
  type: ActionType;
  to?: string;
  url?: string;
  tag?: string;
}

export interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  scope: string;
  kind: ConditionKind;
  cooldownSeconds: number;
  actions: RuleAction[];
  lastFiredAt: Date | null;
  createdAt: Date;
  // metric_threshold
  metric: Metric;
  windowHours: number;
  threshold: number;
  // budget_percent
  period: BudgetPeriod;
  percent: number;
  // keyword_match
  keyword: string;
  matchedIn: KeywordTarget;
  // quality_drop
  minScore: number;
  minSamples: number;
}

export interface FiredAction {
  type: string;
  ok: boolean;
  detail: string;
}

export interface FiringRow {
  id: string;
  ruleId: string;
  ruleName: string;
  firedAt: Date;
  scope: string;
  kind: ConditionKind;
  /**
   * The sentence the worker wrote at the moment it fired.
   *
   * Not re-derived here, on purpose. Three condition types describe themselves with three
   * different sets of fields, and reassembling that in TypeScript would mean two
   * implementations of the same sentence — which would eventually disagree, and the console
   * would be the one that was wrong. The email, the webhook and this table all repeat what
   * the worker said.
   */
  detail: string;
  requestId: string | null;
  actions: FiredAction[];
}

/**
 * A threshold or an observation, printed in the unit its metric is actually in.
 *
 * $5 of cost and 5 requests and 5ms of latency are all the number 5, and a screen that
 * renders them the same way is a screen that will get someone's threshold wrong.
 */
export function metricValue(metric: string, n: number): string {
  switch (metric) {
    case "cost":
      return usd(n);
    case "latency_p95":
      return ms(n);
    case "error_rate":
      return pct(n);
    default:
      return count(n);
  }
}

/** 'key:key_abc' -> 'key_abc'. The prefix is the rollup's business, not the reader's. */
export function scopeLabel(scope: string): string {
  if (scope === "all") return "all traffic";
  const colon = scope.indexOf(":");
  return colon === -1 ? scope : scope.slice(colon + 1);
}

const METRIC_PHRASE: Record<Metric, string> = {
  cost: "cost",
  tokens: "tokens",
  latency_p95: "latency p95",
  error_rate: "error rate",
  request_count: "requests",
};

/** What this rule is watching for, in one line, in whatever terms its condition uses. */
export function ruleSummary(r: RuleRow): string {
  switch (r.kind) {
    case "budget_percent":
      return `${r.period} budget reaches ${r.percent}%`;
    case "keyword_match":
      return r.matchedIn === "either"
        ? `“${r.keyword}” in the prompt or the response`
        : `“${r.keyword}” in the ${r.matchedIn}`;
    case "quality_drop":
      // The sample floor is part of what the rule is, not a detail: the same rule with a
      // floor of 1 and a floor of 50 behave nothing alike on a sampled system.
      return `quality below ${r.minScore} over ≥${r.minSamples} scored calls in the last ${r.windowHours}h`;
    default:
      return `${METRIC_PHRASE[r.metric]} over ${metricValue(r.metric, r.threshold)} in the last ${r.windowHours}h`;
  }
}
