"use client";

import { useRouter } from "next/navigation";

import type { RequestRow } from "@/lib/mongo";
import { count, fmtTs, ms, usd } from "@/lib/format";
import { Badge } from "./Badge";

export function RequestsTable({ rows }: { rows: RequestRow[] }) {
  const router = useRouter();
  if (rows.length === 0) return <div className="empty">No requests match these filters.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Model</th>
            <th>Status</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th className="num">Latency</th>
            <th>Key</th>
            <th>Feature</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => router.push(`/requests/${r.id}`)}>
              <td className="mono">{fmtTs(new Date(r.ts))}</td>
              <td>{r.model}</td>
              <td>
                <Badge status={r.status} cacheHit={r.cacheHit} />
              </td>
              <td className="num">{count(r.totalTokens)}</td>
              <td className="num">{usd(r.cost)}</td>
              <td className="num">{ms(r.latencyMs)}</td>
              <td className="mono">{r.apiKeyId}</td>
              <td>{r.featureTag ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
