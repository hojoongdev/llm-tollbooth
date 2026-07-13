/**
 * The rule vocabulary, and how to print it.
 *
 * Split out of lib/rules.ts because that file is "server-only" — it talks to Mongo —
 * and the client components that render a rule need these *values*, not just their
 * types. A client component importing a value from a server-only module fails the
 * build, which is the guard working as intended.
 */

import { count, ms, pct, usd } from "./format";

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
  metric: Metric;
  windowHours: number;
  threshold: number;
  cooldownSeconds: number;
  actions: RuleAction[];
  lastFiredAt: Date | null;
  createdAt: Date;
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
  metric: string;
  windowHours: number;
  threshold: number;
  observed: number;
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
