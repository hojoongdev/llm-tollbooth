import "server-only";
import { randomBytes } from "node:crypto";

import { db } from "./mongo";
import { METRICS, type Metric, type RuleAction, type FiredAction, type FiringRow, type RuleRow } from "./rule-format";

/**
 * Alert rules: the console writes them, the rules worker acts on them (spec §4,
 * group C).
 *
 * As with api_keys, the two services never call each other — they meet in this
 * collection, which makes the document shape below the contract between them. The
 * snake_case is not incidental: the worker is Python and reads exactly these names.
 *
 * A rule's `scope` is the rollup's `dim` axis verbatim ('all' | 'model:x' | 'key:x'),
 * which is what lets the worker answer "has this key spent more than $5 in the last
 * hour" with one partition read. The scope select on the Rules screen therefore offers
 * exactly the dims that exist.
 *
 * (No project_id, deliberately: the worker does not filter on one, and a field nobody
 * reads is worse than no field. P6 brings tenancy to every collection at once.)
 */

const rules = () => db().collection("rules");
const firings = () => db().collection("rule_firings");

function toRule(d: Record<string, any>): RuleRow {
  const condition = d.condition ?? {};
  return {
    id: String(d._id),
    name: d.name ?? "—",
    // Absent reads as on: a rule that exists is a rule someone wanted.
    enabled: d.enabled !== false,
    scope: d.scope ?? "all",
    metric: ((METRICS as readonly string[]).includes(condition.metric)
      ? condition.metric
      : "cost") as Metric,
    windowHours: Number(condition.window_hours ?? 1),
    threshold: Number(condition.threshold ?? 0),
    cooldownSeconds: Number(d.cooldown_seconds ?? 0),
    actions: Array.isArray(d.actions) ? (d.actions as RuleAction[]) : [],
    lastFiredAt: d.last_fired_at ?? null,
    createdAt: d.created_at ?? new Date(0),
  };
}

function toFiring(d: Record<string, any>): FiringRow {
  return {
    id: String(d._id),
    ruleId: String(d.rule_id ?? ""),
    ruleName: d.rule_name ?? d.rule_id ?? "—",
    firedAt: d.fired_at ?? new Date(0),
    scope: d.scope ?? "all",
    metric: d.metric ?? "—",
    windowHours: Number(d.window_hours ?? 1),
    threshold: Number(d.threshold ?? 0),
    observed: Number(d.observed ?? 0),
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
  metric: Metric;
  windowHours: number;
  threshold: number;
  cooldownSeconds: number;
  actions: RuleAction[];
}

export async function createRule(r: NewRule): Promise<void> {
  await rules().insertOne({
    _id: `rule_${randomBytes(4).toString("hex")}` as never,
    name: r.name,
    enabled: true,
    scope: r.scope,
    // `type` is spelled out even though metric_threshold is the only kind that exists.
    // The worker refuses a condition type it does not know rather than guessing, and
    // P5's quality-drop rule will arrive as a second value here.
    condition: {
      type: "metric_threshold",
      metric: r.metric,
      window_hours: r.windowHours,
      threshold: r.threshold,
    },
    actions: r.actions,
    cooldown_seconds: r.cooldownSeconds,
    last_fired_at: null,
    created_at: new Date(),
  });
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<void> {
  await rules().updateOne({ _id: id as never }, { $set: { enabled } });
}

/** The two numbers anyone actually comes back to tune. */
export async function setRuleTuning(
  id: string,
  threshold: number,
  cooldownSeconds: number,
): Promise<void> {
  await rules().updateOne(
    { _id: id as never },
    { $set: { "condition.threshold": threshold, cooldown_seconds: cooldownSeconds } },
  );
}

/**
 * Clear the cooldown so a rule that already fired can fire again now.
 *
 * The cooldown is there to stop an alert storm. But once someone has actually *dealt*
 * with the thing, sitting out the other twenty-nine minutes to find out whether they
 * fixed it is the opposite of useful.
 */
export async function armRule(id: string): Promise<void> {
  await rules().updateOne({ _id: id as never }, { $set: { last_fired_at: null } });
}

/**
 * Deleting a rule leaves its firings alone. They record what happened, and deleting
 * the rule does not un-happen it.
 */
export async function deleteRule(id: string): Promise<void> {
  await rules().deleteOne({ _id: id as never });
}
