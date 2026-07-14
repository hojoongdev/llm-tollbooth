import type { TrendPoint } from "@/lib/cassandra";
import { count } from "@/lib/format";

/**
 * Average judge score over time, on the 1–5 scale it is actually measured on.
 *
 * The y-axis is fixed to 1–5 rather than scaled to the data, because a quality score has an
 * absolute meaning: an auto-scaled axis would make a window of 4.6-to-4.8 look like a
 * catastrophe and a window of 1.1-to-1.3 look flat.
 *
 * Buckets with no scored calls are *gaps*, not zeroes. Eval samples, so a quiet hour may
 * simply not have been judged — drawing that as a plunge to the floor would invent a quality
 * collapse out of an absence of data, which is the same lie the quality_drop rule refuses to
 * tell. So the line is drawn in segments over the buckets that were scored, and a bucket
 * that stands alone between two empty ones gets a dot, because a segment needs two points and
 * a lone score still happened.
 */
const W = 1000;
const H = 168;
const PAD = 6;
// A horizontal inset as well, unlike the requests chart: this one plots *points*, and a dot
// sitting on the first or last bucket would be sliced in half by the edge of the viewBox.
const PAD_X = 10;
const MIN_SCORE = 1;
const MAX_SCORE = 5;

export function QualityChart({ points, unit }: { points: TrendPoint[]; unit: "hour" | "day" }) {
  const scoredPoints = points.filter((p) => p.scored > 0);
  if (scoredPoints.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        이 기간에 채점된 호출이 없습니다. Settings 에서 샘플링 비율을 올리거나, 트래픽을 흘려보세요.
      </div>
    );
  }

  const n = Math.max(points.length, 2);
  const x = (i: number) => PAD_X + (i / (n - 1)) * (W - 2 * PAD_X);
  const y = (v: number) =>
    PAD + (H - 2 * PAD) * (1 - (v - MIN_SCORE) / (MAX_SCORE - MIN_SCORE));

  // Contiguous runs of scored buckets. A break in the run is a break in the line.
  const runs: { i: number; p: TrendPoint }[][] = [];
  let run: { i: number; p: TrendPoint }[] = [];
  points.forEach((p, i) => {
    if (p.scored > 0) {
      run.push({ i, p });
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);

  const total = scoredPoints.reduce((s, p) => s + p.scored, 0);
  const mean =
    scoredPoints.reduce((s, p) => s + p.quality * p.scored, 0) / Math.max(1, total);

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
          <span className="h-2 w-2 rounded-full bg-primary" /> avg score
        </span>
        <span className="font-mono tabular-nums">
          {mean.toFixed(2)} over {count(total)} scored
        </span>
      </div>

      <div className="flex gap-2">
        {/* The y scale, in HTML rather than in the SVG: preserveAspectRatio="none" stretches
            the plot horizontally to fill the card, and any text inside it would stretch with
            it. Each label is centred on the gridline it names, so the 1–5 scale can actually
            be read off the chart — which is the whole point of pinning the axis to it. */}
        <div className="relative h-[168px] w-3 shrink-0">
          {[5, 4, 3, 2, 1].map((v) => (
            <span
              key={v}
              className="absolute right-0 -translate-y-1/2 font-mono text-[10px] tabular-nums text-muted-foreground"
              style={{ top: `${(y(v) / H) * 100}%` }}
            >
              {v}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <svg className="h-[168px] w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
            {[2, 3, 4].map((v) => (
              <line
                key={v}
                x1={0}
                x2={W}
                y1={y(v)}
                y2={y(v)}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {runs.map((r, k) =>
              r.length === 1 ? (
                // A scored bucket with unscored neighbours. It has no segment to belong to,
                // but it is not nothing.
                <circle key={k} cx={x(r[0].i)} cy={y(r[0].p.quality)} r={3.5} className="fill-primary" />
              ) : (
                <path
                  key={k}
                  d={r.map((s, j) => `${j ? "L" : "M"}${x(s.i).toFixed(1)},${y(s.p.quality).toFixed(1)}`).join(" ")}
                  className="fill-none stroke-primary"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}
          </svg>

          <div className="mt-1.5 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
            {labelIdx.map((i) => (
              <span key={i}>{fmtX(points[i].ts)}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
