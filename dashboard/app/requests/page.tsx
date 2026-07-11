import { listRequests } from "@/lib/mongo";
import { parseRange, windowFor, RANGE_LABEL } from "@/lib/time";
import { Filters } from "@/components/Filters";
import { RangeFilter } from "@/components/RangeFilter";
import { RequestsTable } from "@/components/RequestsTable";

export const dynamic = "force-dynamic";

const LIMIT = 100;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; model?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const w = windowFor(range);
  const rows = await listRequests({ window: w, model: sp.model, status: sp.status, limit: LIMIT });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>
            {RANGE_LABEL[range]} · {rows.length === LIMIT ? `newest ${LIMIT}` : `${rows.length} shown`}
          </p>
        </div>
        <RangeFilter range={range} basePath="/requests" extra={{ model: sp.model, status: sp.status }} />
      </div>

      <Filters range={range} model={sp.model} status={sp.status} />

      <div className="panel">
        <RequestsTable rows={rows} />
      </div>
    </>
  );
}
