import Link from "next/link";

import type { ModelRow } from "@/lib/mongo";
import { count, pct, usd } from "@/lib/format";

export function ModelBreakdown({ rows, range }: { rows: ModelRow[]; range: string }) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  return (
    <div className="panel">
      <h2>
        Cost by model <span className="legend">{rows.length} models · click to filter</span>
      </h2>
      {rows.length === 0 ? (
        <div className="empty">No traffic in this window.</div>
      ) : (
        <div className="bars">
          {rows.map((r) => (
            <Link className="bar-row" key={r.model} href={`/requests?range=${range}&model=${encodeURIComponent(r.model)}`}>
              <div className="name">
                {r.model} <span className="prov">{r.provider ?? ""}</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }} />
              </div>
              <div className="amt">
                {usd(r.cost)} · {count(r.requests)} req
                {r.errors > 0 ? ` · ${pct(r.errors / r.requests)} err` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
