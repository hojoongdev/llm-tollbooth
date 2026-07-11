import { readRollup } from "@/lib/cassandra";
import { modelBreakdown } from "@/lib/mongo";
import { parseRange, windowFor, RANGE_LABEL_KO } from "@/lib/time";
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
  const [overview, models] = await Promise.all([readRollup(w, "all"), modelBreakdown(w)]);

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
      </PageBody>
    </>
  );
}
