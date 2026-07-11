"use client";

import type { RequestRow } from "@/lib/mongo";
import { count, fmtTs, ms, usd } from "@/lib/format";
import { usePendingNav } from "./pending-nav";
import { StatusBadge } from "./status-badge";

export function RequestsTable({ rows }: { rows: RequestRow[] }) {
  const { navigate } = usePendingNav();
  if (rows.length === 0)
    return <div className="py-12 text-center text-sm text-muted-foreground">No requests match these filters.</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">Time (UTC)</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Tokens</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-3 py-2 text-right font-medium">Latency</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Feature</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => navigate(`/requests/${r.id}`)}
              className="cursor-pointer border-b border-border transition-colors hover:bg-accent"
            >
              <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted-foreground">{fmtTs(new Date(r.ts))}</td>
              <td className="whitespace-nowrap px-3 py-2 font-medium">{r.model}</td>
              <td className="whitespace-nowrap px-3 py-2">
                <StatusBadge status={r.status} cacheHit={r.cacheHit} />
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums">{count(r.totalTokens)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums">{usd(r.cost)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums">{ms(r.latencyMs)}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">{r.apiKeyId}</td>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.featureTag ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
