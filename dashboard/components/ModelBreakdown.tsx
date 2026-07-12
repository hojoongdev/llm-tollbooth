import Link from "next/link";

import type { ModelRow } from "@/lib/cassandra";
import { count, pct, usd } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function ModelBreakdown({ rows, range }: { rows: ModelRow[]; range: string }) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost by model</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No traffic in this window.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {rows.map((r) => (
              <Link
                key={r.model}
                href={`/requests?range=${range}&model=${encodeURIComponent(r.model)}`}
                className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
              >
                <div className="w-32 shrink-0 truncate text-sm font-medium sm:w-44">
                  {r.model}
                  {r.provider ? (
                    <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{r.provider}</span>
                  ) : null}
                </div>
                <div className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-muted sm:block">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }} />
                </div>
                <div className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:ml-0">
                  {usd(r.cost)} · {count(r.requests)} req
                  {r.errors > 0 ? ` · ${pct(r.errors / r.requests)} err` : ""}
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
