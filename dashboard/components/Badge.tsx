export function Badge({ status, cacheHit }: { status: string; cacheHit?: boolean }) {
  if (cacheHit && status === "success") return <span className="badge cached">cached</span>;
  const known = ["success", "error", "cached", "blocked"];
  const cls = known.includes(status) ? status : "neutral";
  return <span className={`badge ${cls}`}>{status}</span>;
}
