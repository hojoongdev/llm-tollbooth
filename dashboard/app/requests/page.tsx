import { listRequests } from "@/lib/mongo";
import { parseRange, windowFor, RANGE_LABEL_KO } from "@/lib/time";
import { Filters } from "@/components/Filters";
import { PageBody, PageHeader } from "@/components/page-header";
import { RangeFilter } from "@/components/RangeFilter";
import { RequestsTable } from "@/components/RequestsTable";
import { Card } from "@/components/ui/card";

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
      <PageHeader
        title="Requests"
        description={`${RANGE_LABEL_KO[range]} · ${rows.length === LIMIT ? `최신 ${LIMIT}건` : `${rows.length}건`}`}
      >
        <RangeFilter range={range} basePath="/requests" extra={{ model: sp.model, status: sp.status }} />
      </PageHeader>
      <PageBody>
        <Filters range={range} model={sp.model} status={sp.status} />
        <Card className="overflow-hidden">
          <RequestsTable rows={rows} />
        </Card>
      </PageBody>
    </>
  );
}
