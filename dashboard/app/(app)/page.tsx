import { budgetBurn } from "@/lib/budget";
import { modelBreakdown, readRollup } from "@/lib/cassandra";
import { parseRange, windowFor, RANGE_LABEL_KO } from "@/lib/time";
import { BudgetBurn } from "@/components/BudgetBurn";
import { Cards } from "@/components/Cards";
import { ModelBreakdown } from "@/components/ModelBreakdown";
import { PageBody, PageHeader } from "@/components/page-header";
import { RangeFilter } from "@/components/RangeFilter";
import { TrendChart } from "@/components/TrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseRange((await searchParams).range);
  const w = windowFor(range);
  // budgetBurn takes no window, and that is not an oversight: a cap is a calendar thing.
  // It always reads today and this month, in UTC, because that is what the gateway
  // enforces against.
  const [overview, models, burn] = await Promise.all([
    readRollup(w, "all"),
    modelBreakdown(w),
    budgetBurn(),
  ]);

  return (
    <>
      <PageHeader title="Overview" description={`${RANGE_LABEL_KO[range]} · 프로젝트 default`}>
        <RangeFilter range={range} basePath="/" />
      </PageHeader>
      <PageBody>
        <Cards totals={overview.totals} />
        <Card>
          <CardHeader>
            <CardTitle>Requests over time</CardTitle>
          </CardHeader>
          <CardContent>
            <TrendChart points={overview.trend} unit={w.unit} />
          </CardContent>
        </Card>
        <ModelBreakdown rows={models} range={range} />
        <BudgetBurn rows={burn} />
      </PageBody>
    </>
  );
}
