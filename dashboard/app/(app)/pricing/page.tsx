import { listPricing } from "@/lib/pricing";
import { NewPriceForm, PricingTable } from "@/components/PricingTable";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const rows = await listPricing();

  return (
    <>
      <PageHeader
        title="Pricing"
        description="모델별 단가표 — 모든 호출의 비용이 이 표에서 계산되고, provider 값이 곧 라우팅 대상입니다"
      />
      <PageBody>
        <NewPriceForm />
        <Card className="overflow-hidden">
          <PricingTable rows={rows} />
        </Card>
      </PageBody>
    </>
  );
}
