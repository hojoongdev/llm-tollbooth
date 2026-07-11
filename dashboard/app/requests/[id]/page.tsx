import Link from "next/link";
import { notFound } from "next/navigation";

import { getRequest } from "@/lib/mongo";
import { count, fmtTs, ms, usd } from "@/lib/format";
import { Badge } from "@/components/Badge";

export const dynamic = "force-dynamic";

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getRequest(id);
  if (!r) notFound();

  const rows: [string, string][] = [
    ["Event ID", r.id],
    ["Time (UTC)", fmtTs(new Date(r.ts))],
    ["Provider", r.provider ?? "—"],
    ["Model", r.model],
    ["Endpoint", r.endpoint ?? "—"],
    ["API key", r.apiKeyId],
    ["Status", r.status],
    ["Cache hit", String(r.cacheHit)],
    ["Prompt tokens", count(r.promptTokens)],
    ["Completion tokens", count(r.completionTokens)],
    ["Total tokens", count(r.totalTokens)],
    ["Cost", usd(r.cost)],
    ["Latency", ms(r.latencyMs)],
    ["TTFB", r.ttfbMs == null ? "—" : ms(r.ttfbMs)],
    ["Error type", r.errorType ?? "—"],
    ["Feature tag", r.featureTag ?? "—"],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/requests" className="back">
            ← Requests
          </Link>
          <h1 style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10 }}>
            Request <span style={{ fontFamily: "var(--mono)", color: "var(--muted)", fontSize: 15 }}>{r.id.slice(0, 8)}</span>
            <Badge status={r.status} cacheHit={r.cacheHit} />
          </h1>
        </div>
      </div>

      <div className="detail-grid">
        {rows.map(([k, v]) => (
          <div className="kv" key={k}>
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>

      <p className="note">
        Prompt &amp; response bodies show here once the gateway (P3) records them — loadgen events carry metrics only.
      </p>
    </>
  );
}
