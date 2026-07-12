import Link from "next/link";

import type { Range } from "@/lib/time";
import { cn } from "@/lib/utils";

const STATUSES = ["success", "error"];

export function Filters({ range, model, status }: { range: Range; model?: string; status?: string }) {
  const href = (patch: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { range, model, status, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/requests?${p.toString()}`;
  };
  const pill = (active: boolean) =>
    cn(
      "rounded px-2 py-1 text-xs font-medium transition-colors",
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
        <span className="px-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">status</span>
        <Link href={href({ status: undefined })} className={pill(!status)}>
          all
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={href({ status: s })} className={pill(status === s)}>
            {s}
          </Link>
        ))}
      </div>
      {model ? (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs">
          <span className="text-muted-foreground">model</span>
          <span className="font-mono">{model}</span>
          <Link href={href({ model: undefined })} className="text-muted-foreground hover:text-destructive" aria-label="clear model filter">
            ✕
          </Link>
        </div>
      ) : null}
    </div>
  );
}
