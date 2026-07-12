// Small display formatters shared across screens.

export function usd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

export function pct(n: number): string {
  return (n * 100).toFixed(n < 0.1 ? 2 : 1) + "%";
}

export function ms(n: number): string {
  if (n < 1000) return Math.round(n) + " ms";
  return (n / 1000).toFixed(2) + " s";
}

export function tokens(n: number): string {
  return count(n) + " tok";
}

/** Deterministic UTC timestamp — identical on server and client, so no
 *  hydration mismatch when a client component re-renders the table. */
export function fmtTs(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function ago(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
