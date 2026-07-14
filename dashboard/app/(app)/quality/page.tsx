import Link from "next/link";

import { modelBreakdown, readRollup } from "@/lib/cassandra";
import { listScored, readEvalSettings } from "@/lib/eval";
import { count, pct } from "@/lib/format";
import { parseRange, windowFor, RANGE_LABEL_KO } from "@/lib/time";
import { PageBody, PageHeader } from "@/components/page-header";
import { QualityByModel } from "@/components/QualityByModel";
import { QualityChart } from "@/components/QualityChart";
import { RangeFilter } from "@/components/RangeFilter";
import { ScoredCalls } from "@/components/ScoredCalls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * Quality (spec §8 screen 7): the trend, the model comparison, and the calls that scored
 * worst.
 *
 * Everything here is read from the same hourly rollup the Overview reads — the eval worker
 * writes its scores onto those very rows — except the list of individual scored calls, which
 * is the embed on the request documents. So a wide window is still a handful of partition
 * reads, exactly as elsewhere.
 */
export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseRange((await searchParams).range);
  const w = windowFor(range);

  const [overview, models, scored, settings] = await Promise.all([
    readRollup(w, "all"),
    modelBreakdown(w),
    listScored(w.start),
    readEvalSettings(),
  ]);

  const { quality, scored: judged, requests } = overview.totals;
  // Sampling means this is the number that says how much the average is worth. Showing an
  // average without it would let a 1.0 over two calls read like a verdict on the system.
  const coverage = requests ? judged / requests : 0;

  return (
    <>
      <PageHeader title="Quality" description={`${RANGE_LABEL_KO[range]} · 프로젝트 default`}>
        <RangeFilter range={range} basePath="/quality" />
      </PageHeader>

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Avg quality"
            // Not "0.00" when nothing is scored: an unjudged window has no average, and
            // printing one would report a working system as a failing one.
            value={judged ? `${quality.toFixed(2)}` : "—"}
            sub={judged ? "1–5, higher is better" : "아직 채점된 호출이 없습니다"}
            err={judged > 0 && quality < 3}
          />
          <Stat label="Scored" value={count(judged)} sub={`${count(requests)} requests in window`} />
          <Stat
            label="Coverage"
            value={requests ? pct(coverage) : "—"}
            sub={`샘플링 ${pct(settings.sampleRate)} ${settings.enabled ? "" : "· 꺼짐"}`}
          />
          <Stat label="Judge" value={settings.evalModel} sub="Settings 에서 변경" mono={false} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Quality over time</CardTitle>
          </CardHeader>
          <CardContent>
            <QualityChart points={overview.trend} unit={w.unit} />
          </CardContent>
        </Card>

        <QualityByModel rows={models} />
        <ScoredCalls rows={scored} />

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          평가는 <strong className="font-medium">샘플링</strong>입니다 — 평균은 채점된 호출 수로 나눕니다(전체 요청 수가
          아니라). 채점이 없는 구간은 0점이 아니라 <strong className="font-medium">공백</strong>으로 둡니다. 품질이
          떨어지면 알림을 받으려면 <Link href="/rules" className="underline underline-offset-2 hover:text-foreground">Rules</Link>{" "}
          에서 <span className="font-mono">quality_drop</span> 규칙을 거세요.
        </p>
      </PageBody>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  err,
  mono = true,
}: {
  label: string;
  value: string;
  sub: string;
  err?: boolean;
  mono?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-1.5 truncate text-2xl font-semibold tracking-tight ${
          mono ? "font-mono tabular-nums" : "text-lg"
        } ${err ? "text-destructive" : ""}`}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </Card>
  );
}
