import Link from "next/link";

import type { BurnRow } from "@/lib/budget";
import { pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

/**
 * How close each key is to being cut off.
 *
 * Not affected by the range filter, on purpose: a budget is a calendar thing. "How much
 * of my daily cap is gone" has one answer, and it is not a function of which chart range
 * someone happened to leave selected.
 */
export function BudgetBurn({ rows }: { rows: BurnRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget burn</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No key has a budget.{" "}
            <Link href="/keys" className="text-primary underline-offset-2 hover:underline">
              Set one on API Keys
            </Link>{" "}
            — until then there is nothing here to be over.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name}</span>
                  <code className="font-mono text-[11px] text-muted-foreground">{r.id}</code>
                  {r.status === "blocked" ? <Badge variant="destructive">blocked</Badge> : null}
                </div>

                {r.dailyUsd !== null ? (
                  <Meter label="daily" spent={r.spentToday} cap={r.dailyUsd} />
                ) : null}
                {r.monthlyUsd !== null ? (
                  <Meter label="monthly" spent={r.spentThisMonth} cap={r.monthlyUsd} />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Meter({ label, spent, cap }: { label: string; spent: number; cap: number }) {
  const ratio = cap > 0 ? spent / cap : 1;

  // The gateway refuses at >=, not >, so a full bar is not "nearly out" — it is out.
  // Warning at 80% is the point where a human still has time to do something about it.
  const tone = ratio >= 1 ? "bg-destructive" : ratio >= 0.8 ? "bg-warning" : "bg-primary";

  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width]", tone)}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {usd(spent)} / {usd(cap)}
      </span>
      <span
        className={cn(
          "w-14 shrink-0 text-right font-mono text-xs tabular-nums",
          ratio >= 1 ? "font-semibold text-destructive" : ratio >= 0.8 ? "text-warning" : "text-muted-foreground",
        )}
      >
        {pct(ratio)}
      </span>
    </div>
  );
}
