import { listKeys } from "@/lib/keys";
import { KeysTable } from "@/components/KeysTable";
import { NewKeyForm } from "@/components/NewKeyForm";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const keys = await listKeys();

  return (
    <>
      <PageHeader
        title="API Keys"
        description="게이트웨이 호출에 쓰는 키 — 발급·차단·폐기, 키별 예산과 레이트 리밋"
      />
      <PageBody>
        <NewKeyForm />
        <Card className="overflow-hidden">
          <KeysTable rows={keys} />
        </Card>
      </PageBody>
    </>
  );
}
