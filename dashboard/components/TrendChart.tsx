import type { TrendPoint } from "@/lib/cassandra";
import { count } from "@/lib/format";

// Pure server-rendered SVG (no client JS). The plot stretches to fill width via
// preserveAspectRatio="none"; axis labels live in HTML below the SVG so they
// stay crisp and evenly spaced instead of being stretched with the graphics.
const W = 1000;
const H = 168;
const PAD = 6;

export function TrendChart({ points, unit }: { points: TrendPoint[]; unit: "hour" | "day" }) {
  if (points.length === 0) return <div className="empty">No data in this window.</div>;

  // One real point renders as a flat line across the width.
  const pts = points.length === 1 ? [points[0], points[0]] : points;
  const n = pts.length;
  const max = Math.max(1, ...pts.map((p) => p.requests));

  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => PAD + (H - 2 * PAD) * (1 - v / max);
  const baseline = H - PAD;

  const path = (sel: (p: TrendPoint) => number) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(" ");

  const reqLine = path((p) => p.requests);
  const area = `${reqLine} L${W},${baseline} L0,${baseline} Z`;
  const errLine = path((p) => p.errors);
  const hasErrors = pts.some((p) => p.errors > 0);

  // ~6 evenly spaced x labels from the underlying (un-doubled) points.
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
    <div className="chart-box">
      <div className="chart-cap">peak {count(max)} req/{unit}</div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <defs>
          <linearGradient id="req-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#req-fill)" />
        <path d={reqLine} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {hasErrors && (
          <path
            d={errLine}
            fill="none"
            stroke="var(--err)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            opacity="0.9"
          />
        )}
      </svg>
      <div className="chart-x">
        {labelIdx.map((i) => (
          <span key={i}>{fmtX(points[i].ts)}</span>
        ))}
      </div>
    </div>
  );
}
