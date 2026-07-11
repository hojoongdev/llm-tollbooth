import type { Totals } from "@/lib/cassandra";
import { count, ms, pct, tokens, usd } from "@/lib/format";

function Stat({ label, value, sub, err }: { label: string; value: string; sub: string; err?: boolean }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className={err ? "sub err" : "sub"}>{sub}</div>
    </div>
  );
}

export function Cards({ totals }: { totals: Totals }) {
  return (
    <div className="cards">
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
