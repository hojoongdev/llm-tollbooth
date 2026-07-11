import Link from "next/link";

import type { Range } from "@/lib/time";

const STATUSES = ["success", "error"];

export function Filters({ range, model, status }: { range: Range; model?: string; status?: string }) {
  const href = (patch: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { range, model, status, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/requests?${p.toString()}`;
  };
  return (
    <div className="filters">
      <span className="chip">
        status:
        <Link href={href({ status: undefined })} style={{ fontWeight: !status ? 700 : 400 }}>
          {" "}all
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={href({ status: s })} style={{ fontWeight: status === s ? 700 : 400 }}>
            {" "}
            {s}
          </Link>
        ))}
      </span>
      {model ? (
        <span className="chip">
          model: {model} <Link href={href({ model: undefined })}>×</Link>
        </span>
      ) : null}
    </div>
  );
}
