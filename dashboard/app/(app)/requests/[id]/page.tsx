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

  // Only calls that went through the gateway carry bodies; a synthetic loadgen
  // event is metrics and nothing else.
  const hasBodies = Boolean(r.messages?.length || r.answer || r.error);

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

        {r.messages?.length ? (
          <Panel title="Prompt">
            <div className="divide-y divide-border">
              {r.messages.map((m, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {m.role}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
                    {m.content}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        {r.answer ? (
          <Panel title="Response">
            <p className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed">
              {r.answer}
            </p>
          </Panel>
        ) : null}

        {r.error ? (
          <Panel title="Error">
            <p className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-destructive">
              {r.error}
            </p>
          </Panel>
        ) : null}

        {!hasBodies ? (
          <p className="text-xs text-muted-foreground">
            본문 없음 — 게이트웨이를 거친 호출만 프롬프트·응답을 기록합니다. loadgen 이벤트는 지표만 담습니다.
          </p>
        ) : null}
      </PageBody>
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </Card>
  );
}
