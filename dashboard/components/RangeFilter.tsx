import Link from "next/link";

import { RANGES, type Range } from "@/lib/time";

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
    <div className="seg">
      {RANGES.map((r) => (
        <Link key={r} href={href(r)} className={r === range ? "active" : ""}>
          {r}
        </Link>
      ))}
    </div>
  );
}
