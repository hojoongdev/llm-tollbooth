import { readRollup } from "@/lib/cassandra";
import { modelBreakdown } from "@/lib/mongo";
import { parseRange, windowFor, RANGE_LABEL } from "@/lib/time";
import { Cards } from "@/components/Cards";
import { ModelBreakdown } from "@/components/ModelBreakdown";
import { RangeFilter } from "@/components/RangeFilter";
import { TrendChart } from "@/components/TrendChart";

// Live data on every load — never prerendered or cached.
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
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>{RANGE_LABEL[range]}</p>
        </div>
        <RangeFilter range={range} basePath="/" />
      </div>

      <Cards totals={overview.totals} />

      <div className="panel">
        <h2>
          Requests over time
          <span className="legend">requests · errors (hourly rollup)</span>
        </h2>
        <TrendChart points={overview.trend} unit={w.unit} />
      </div>

      <ModelBreakdown rows={models} range={range} />
    </>
  );
}
