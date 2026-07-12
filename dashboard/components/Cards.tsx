import type { Totals } from "@/lib/cassandra";
import { count, ms, pct, tokens, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card } from "./ui/card";

function Stat({ label, value, sub, err }: { label: string; value: string; sub: string; err?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className={cn("mt-1 text-xs", err ? "text-destructive" : "text-muted-foreground")}>{sub}</div>
    </Card>
  );
}

export function Cards({ totals }: { totals: Totals }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label="Cost"
        value={usd(totals.cost)}
        sub={`${tokens(totals.totalTokens)} · ${count(totals.promptTokens)} in / ${count(totals.completionTokens)} out`}
      />
      <Stat
        label="Requests"
        value={count(totals.requests)}
        sub={`${count(totals.cacheHits)} cache hits · ${pct(totals.cacheHitRate)}`}
      />
      <Stat
        label="Error rate"
        value={pct(totals.errorRate)}
        sub={`${count(totals.errors)} errors`}
        err={totals.errors > 0}
      />
      <Stat label="Avg latency" value={ms(totals.avgLatency)} sub="mean over window" />
    </div>
  );
}
