"use client";

import { BellRing, Pause, Play, RotateCcw, Save, Trash2 } from "lucide-react";

import { rearmRule, removeRule, toggleRule, tuneRule } from "@/app/(app)/rules/actions";
import { ago } from "@/lib/format";
import { METRIC_UNIT, metricValue, scopeLabel, type RuleRow } from "@/lib/rule-format";
import { Badge } from "@/components/ui/badge";
import { BUTTON_QUIET } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";

const METRIC_PHRASE: Record<string, string> = {
  cost: "cost",
  tokens: "tokens",
  latency_p95: "latency p95",
  error_rate: "error rate",
  request_count: "requests",
};

export function RulesTable({ rows, now }: { rows: RuleRow[]; now: number }) {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No rules yet. Nothing is watching the gateway — add one above.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        // A rule inside its cooldown is armed but deliberately silent, and that is a
        // third state worth showing: "enabled" alone would imply it is about to fire.
        const cooling =
          r.lastFiredAt !== null &&
          now - new Date(r.lastFiredAt).getTime() < r.cooldownSeconds * 1000;

        return (
          <li key={r.id} className="flex flex-col gap-3 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{r.name}</span>

              {!r.enabled ? (
                <Badge variant="muted">paused</Badge>
              ) : cooling ? (
                <Badge variant="warning">cooling down</Badge>
              ) : (
                <Badge variant="success">armed</Badge>
              )}

              <span className="text-xs text-muted-foreground">
                <span className="font-mono">{scopeLabel(r.scope)}</span>
                {" · "}
                {METRIC_PHRASE[r.metric] ?? r.metric} over{" "}
                <span className="font-mono tabular-nums">{metricValue(r.metric, r.threshold)}</span>
                {" in the last "}
                {r.windowHours}h
              </span>

              {r.actions.length > 0 ? (
                <span className="flex items-center gap-1">
                  {r.actions.map((a) => (
                    <Badge key={a.type} variant="info">
                      {a.type}
                      {a.type === "email" && a.to ? `: ${a.to}` : null}
                      {a.type === "tag" && a.tag ? `: ${a.tag}` : null}
                    </Badge>
                  ))}
                </span>
              ) : (
                <Badge variant="destructive">no actions</Badge>
              )}

              {r.lastFiredAt ? (
                <span className="text-[11px] text-muted-foreground">
                  last fired {ago(new Date(r.lastFiredAt))}
                </span>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                {/* Separate forms, side by side — a form inside a form is not a thing. */}
                {cooling ? (
                  <form action={rearmRule}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className={BUTTON_QUIET} title="Clear the cooldown so it can fire again now">
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} /> Re-arm
                    </button>
                  </form>
                ) : null}

                <form action={toggleRule}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="enabled" value={String(r.enabled)} />
                  <button type="submit" className={BUTTON_QUIET}>
                    {r.enabled ? (
                      <>
                        <Pause className="h-3.5 w-3.5" strokeWidth={2} /> Pause
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" strokeWidth={2} /> Resume
                      </>
                    )}
                  </button>
                </form>

                <form action={removeRule}>
                  <input type="hidden" name="id" value={r.id} />
                  <button
                    type="submit"
                    className={`${BUTTON_QUIET} hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive`}
                    title="Deleting a rule leaves its firing history alone"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2} /> Delete
                  </button>
                </form>
              </div>
            </div>

            {/* The two numbers anyone actually comes back to tune. Everything else about
                a rule is what it *is*; change that and it's a different rule. */}
            <form action={tuneRule} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={r.id} />
              <Field
                label={`Over (${METRIC_UNIT[r.metric]})`}
                name="threshold"
                type="number"
                step="any"
                min="0"
                defaultValue={r.threshold}
                className="w-32"
              />
              <Field
                label="Cooldown (min)"
                name="cooldown_minutes"
                type="number"
                step="1"
                min="0"
                defaultValue={Math.round(r.cooldownSeconds / 60)}
                className="w-32"
              />
              <button type="submit" className={BUTTON_QUIET}>
                <Save className="h-3.5 w-3.5" strokeWidth={2} /> Save
              </button>
              <span className="pb-1.5 text-[11px] text-muted-foreground">
                <BellRing className="mr-1 inline h-3 w-3" strokeWidth={2} />
                <code className="font-mono">{r.id}</code>
              </span>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
