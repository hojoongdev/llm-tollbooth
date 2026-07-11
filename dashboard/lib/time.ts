// Period-filter helpers. Everything is computed in UTC because that's how the
// ingest worker buckets rollup rows (day/hour) and stamps request timestamps.

export type Range = "1h" | "24h" | "7d" | "30d";

export const RANGES: Range[] = ["1h", "24h", "7d", "30d"];

export const RANGE_LABEL: Record<Range, string> = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

// Korean descriptions (UI labels stay English; prose is Korean per the design system).
export const RANGE_LABEL_KO: Record<Range, string> = {
  "1h": "최근 1시간",
  "24h": "최근 24시간",
  "7d": "최근 7일",
  "30d": "최근 30일",
};

export function parseRange(v: string | undefined): Range {
  return RANGES.includes(v as Range) ? (v as Range) : "24h";
}

const RANGE_MS: Record<Range, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export interface Window {
  start: Date;
  end: Date;
  /** Trend granularity: hourly for short ranges, daily for long ones. */
  unit: "hour" | "day";
}

export function windowFor(range: Range, now: Date = new Date()): Window {
  return {
    start: new Date(now.getTime() - RANGE_MS[range]),
    end: now,
    unit: range === "1h" || range === "24h" ? "hour" : "day",
  };
}

/** YYYY-MM-DD for the row's `day` partition key (UTC). */
export function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Distinct UTC day partitions the window touches, oldest first. */
export function daysInWindow(w: Window): string[] {
  const days: string[] = [];
  const cur = new Date(Date.UTC(w.start.getUTCFullYear(), w.start.getUTCMonth(), w.start.getUTCDate()));
  const last = Date.UTC(w.end.getUTCFullYear(), w.end.getUTCMonth(), w.end.getUTCDate());
  while (cur.getTime() <= last) {
    days.push(dayStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** Ordered list of empty trend buckets spanning the window, so the chart is
 *  continuous even where no events landed. Keyed by epoch ms at bucket start. */
export function emptyBuckets(w: Window): number[] {
  const out: number[] = [];
  const step = w.unit === "hour" ? 3_600_000 : 86_400_000;
  const floor = (t: number) => Math.floor(t / step) * step;
  for (let t = floor(w.start.getTime()); t <= w.end.getTime(); t += step) out.push(t);
  return out;
}
