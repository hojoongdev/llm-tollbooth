import "server-only";
import { randomBytes } from "node:crypto";

import { db } from "./mongo";
import {
  BUDGET_PERIODS,
  CONDITIONS,
  KEYWORD_TARGETS,
  METRICS,
  type BudgetPeriod,
  type ConditionKind,
  type FiredAction,
  type FiringRow,
  type KeywordTarget,
  type Metric,
  type RuleAction,
  type RuleRow,
} from "./rule-format";

/**
 * Alert rules: the console writes them, the rules worker acts on them (spec §4, group C).
 *
 * As with api_keys, the two services never call each other — they meet in this collection,
 * which makes the document shape below the contract between them. The snake_case is not
 * incidental: the worker is Python and reads exactly these names.
 *
 * A rule's `scope` is the rollup's `dim` axis verbatim ('all' | 'model:x' | 'key:x'), which
 * is what lets the worker answer "has this key spent more than $5 in the last hour" with one
 * partition read. The scope select on the Rules screen therefore offers exactly the dims that
 * exist.
 *
 * (No project_id, deliberately: the worker does not filter on one, and a field nobody reads
 * is worse than no field. P6 brings tenancy to every collection at once.)
 */

const rules = () => db().collection("rules");
const firings = () => db().collection("rule_firings");

const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  (allowed as readonly string[]).includes(v as string) ? (v as T) : fallback;

function toRule(d: Record<string, any>): RuleRow {
  const c = d.condition ?? {};
  return {
    id: String(d._id),
    name: d.name ?? "—",
    // Absent reads as on: a rule that exists is a rule someone wanted.
    enabled: d.enabled !== false,
    scope: d.scope ?? "all",
    kind: oneOf<ConditionKind>(CONDITIONS, c.type, "metric_threshold"),
    cooldownSeconds: Number(d.cooldown_seconds ?? 0),
    actions: Array.isArray(d.actions) ? (d.actions as RuleAction[]) : [],
    lastFiredAt: d.last_fired_at ?? null,
    createdAt: d.created_at ?? new Date(0),

    metric: oneOf<Metric>(METRICS, c.metric, "cost"),
    windowHours: Number(c.window_hours ?? 1),
    threshold: Number(c.threshold ?? 0),

    period: oneOf<BudgetPeriod>(BUDGET_PERIODS, c.period, "daily"),
    percent: Number(c.percent ?? 80),

    keyword: String(c.keyword ?? ""),
    matchedIn: oneOf<KeywordTarget>(KEYWORD_TARGETS, c.matched_in, "either"),
  };
}

function toFiring(d: Record<string, any>): FiringRow {
  return {
    id: String(d._id),
    ruleId: String(d.rule_id ?? ""),
    ruleName: d.rule_name ?? d.rule_id ?? "—",
    firedAt: d.fired_at ?? new Date(0),
    scope: d.scope ?? "all",
    kind: oneOf<ConditionKind>(CONDITIONS, d.condition_type, "metric_threshold"),
    detail: d.detail ?? "—",
    requestId: d.request_id ?? null,
    actions: Array.isArray(d.actions) ? (d.actions as FiredAction[]) : [],
  };
}

export async function listRules(): Promise<RuleRow[]> {
  const docs = await rules().find({}).sort({ created_at: -1 }).toArray();
  return docs.map(toRule);
}

export async function listFirings(limit = 50): Promise<FiringRow[]> {
  const docs = await firings().find({}).sort({ fired_at: -1 }).limit(limit).toArray();
  return docs.map(toFiring);
}

export interface NewRule {
  name: string;
  scope: string;
  kind: ConditionKind;
  cooldownSeconds: number;
  actions: RuleAction[];
  // Only the fields its kind actually uses are read below.
  metric?: Metric;
  windowHours?: number;
  threshold?: number;
  period?: BudgetPeriod;
  percent?: number;
  keyword?: string;
  matchedIn?: KeywordTarget;
}

/**
 * The condition document, in the shape the Python worker reads.
 *
 * Each kind writes only its own fields. Writing all of them and letting the worker pick
 * would leave a budget rule carrying a `window_hours` that means nothing — and the next
 * person to read the collection would reasonably believe it did.
 */
function conditionOf(r: NewRule): Record<string, unknown> {
  switch (r.kind) {
    case "budget_percent":
      return { type: "budget_percent", period: r.period, percent: r.percent };
    case "keyword_match":
      return { type: "keyword_match", keyword: r.keyword, matched_in: r.matchedIn };
    default:
      return {
        type: "metric_threshold",
        metric: r.metric,
        window_hours: r.windowHours,
        threshold: r.threshold,
      };
  }
}

export async function createRule(r: NewRule): Promise<void> {
  await rules().insertOne({
    _id: `rule_${randomBytes(4).toString("hex")}` as never,
    name: r.name,
    enabled: true,
    scope: r.scope,
    condition: conditionOf(r),
    actions: r.actions,
    cooldown_seconds: r.cooldownSeconds,
    last_fired_at: null,
    created_at: new Date(),
  });
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<void> {
  await rules().updateOne({ _id: id as never }, { $set: { enabled } });
}

/**
 * The numbers anyone actually comes back to tune — which are not the same numbers for
 * every condition. A threshold rule has a threshold; a budget rule has a percentage; a
 * keyword rule has neither, and only its cooldown is worth a second thought.
 */
export async function setRuleTuning(
  id: string,
  kind: ConditionKind,
  value: number,
  cooldownSeconds: number,
): Promise<void> {
  const set: Record<string, unknown> = { cooldown_seconds: cooldownSeconds };
  if (kind === "metric_threshold") set["condition.threshold"] = value;
  if (kind === "budget_percent") set["condition.percent"] = value;

  await rules().updateOne({ _id: id as never }, { $set: set });
}

/**
 * Clear the cooldown so a rule that already fired can fire again now.
 *
 * The cooldown is there to stop an alert storm. But once someone has actually *dealt* with
 * the thing, sitting out the other twenty-nine minutes to find out whether they fixed it is
 * the opposite of useful.
 */
export async function armRule(id: string): Promise<void> {
  await rules().updateOne({ _id: id as never }, { $set: { last_fired_at: null } });
}

/**
 * Deleting a rule leaves its firings alone. They record what happened, and deleting the
 * rule does not un-happen it.
 */
export async function deleteRule(id: string): Promise<void> {
  await rules().deleteOne({ _id: id as never });
}
