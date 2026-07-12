import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getRequest } from "@/lib/mongo";
import { count, fmtTs, ms, usd } from "@/lib/format";
import { PageBody } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";

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
      <header className="sticky top-12 z-20 flex shrink-0 items-center gap-3 border-b border-border bg-card px-6 py-3 md:top-0">
        <div className="flex min-w-0 flex-col gap-1 leading-tight">
          <Link href="/requests" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronLeft className="h-3 w-3" strokeWidth={2} />
            Requests
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold tracking-tight">
              Request <span className="font-mono text-muted-foreground">{r.id.slice(0, 8)}</span>
            </h1>
            <StatusBadge status={r.status} cacheHit={r.cacheHit} />
          </div>
        </div>
      </header>
      <PageBody>
        <Card className="overflow-hidden">
          <dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="bg-card px-4 py-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 break-all font-mono text-sm">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <p className="text-xs text-muted-foreground">
          프롬프트·응답 본문은 게이트웨이(P3)가 기록하면 여기 표시됩니다 — loadgen 이벤트는 지표만 담습니다.
        </p>
      </PageBody>
    </>
  );
}
