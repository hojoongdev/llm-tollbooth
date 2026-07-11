import Link from "next/link";

import { RANGES, type Range } from "@/lib/time";
import { cn } from "@/lib/utils";

export function RangeFilter({
  range,
  basePath,
  extra,
}: {
  range: Range;
  basePath: string;
  extra?: Record<string, string | undefined>;
}) {
  const href = (r: Range) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
    p.set("range", r);
    return `${basePath}?${p.toString()}`;
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={href(r)}
          className={cn(
            "rounded px-2 py-1 text-xs font-medium tabular-nums transition-colors",
            r === range ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r}
        </Link>
      ))}
    </div>
  );
}
