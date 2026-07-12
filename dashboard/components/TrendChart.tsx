import type { TrendPoint } from "@/lib/cassandra";
import { count } from "@/lib/format";

// Server-rendered SVG. Plot stretches to fill width (preserveAspectRatio=none);
// axis labels live in HTML below so they stay crisp. Colors come from the design
// tokens — flat primary area, primary line, destructive line for errors.
const W = 1000;
const H = 168;
const PAD = 6;

export function TrendChart({ points, unit }: { points: TrendPoint[]; unit: "hour" | "day" }) {
  if (points.length === 0)
    return <div className="py-12 text-center text-sm text-muted-foreground">No data in this window.</div>;

  const pts = points.length === 1 ? [points[0], points[0]] : points;
  const n = pts.length;
  const max = Math.max(1, ...pts.map((p) => p.requests));
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => PAD + (H - 2 * PAD) * (1 - v / max);
  const baseline = H - PAD;

  const pathOf = (sel: (p: TrendPoint) => number) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(" ");
  const reqLine = pathOf((p) => p.requests);
  const area = `${reqLine} L${W},${baseline} L0,${baseline} Z`;
  const errLine = pathOf((p) => p.errors);
  const hasErrors = pts.some((p) => p.errors > 0);

  const labelIdx: number[] = [];
  const step = Math.max(1, Math.floor((points.length - 1) / 5));
  for (let i = 0; i < points.length; i += step) labelIdx.push(i);
  if (labelIdx[labelIdx.length - 1] !== points.length - 1) labelIdx.push(points.length - 1);
  const fmtX = (ts: number) => {
    const d = new Date(ts);
    return unit === "hour"
      ? String(d.getUTCHours()).padStart(2, "0") + ":00"
      : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-primary" /> requests
        </span>
        {hasErrors && (
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-destructive" /> errors
          </span>
        )}
        <span className="font-mono tabular-nums">
          peak {count(max)}/{unit}
        </span>
      </div>
      <svg className="h-[168px] w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <path d={area} className="fill-primary/10" />
        <path d={reqLine} className="fill-none stroke-primary" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {hasErrors && (
          <path d={errLine} className="fill-none stroke-destructive" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="mt-1.5 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
        {labelIdx.map((i) => (
          <span key={i}>{fmtX(points[i].ts)}</span>
        ))}
      </div>
    </div>
  );
}
