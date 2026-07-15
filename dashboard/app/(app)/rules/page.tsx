import { modelsInWindow } from "@/lib/cassandra";
import { listKeys } from "@/lib/keys";
import { currentProject } from "@/lib/project";
import { listFirings, listRules } from "@/lib/rules";
import { windowFor } from "@/lib/time";
import { FiringHistory } from "@/components/FiringHistory";
import { NewRuleForm } from "@/components/NewRuleForm";
import { PageBody, PageHeader } from "@/components/page-header";
import { RulesTable } from "@/components/RulesTable";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  // The scope select can only offer dims that exist. A model nobody has called has no
  // rollup partition, so a rule scoped to it would be a rule that can never fire — 30d
  // is wide enough to include a model that went quiet without dropping it entirely.
  const { id: projectId } = await currentProject();
  const [rules, firings, keys, models] = await Promise.all([
    listRules(projectId),
    listFirings(projectId),
    listKeys(projectId),
    modelsInWindow(projectId, windowFor("30d")),
  ]);

  return (
    <>
      <PageHeader
        title="Rules"
        description="조건이 충족되면 알린다 — 시간 창 기준 임계값, 메일·웹훅·차단·태그, 그리고 쿨다운"
      />
      <PageBody>
        <NewRuleForm
          models={models}
          keys={keys.map((k) => ({ value: `key:${k.id}`, label: `${k.name} (${k.id})` }))}
        />

        <Card className="overflow-hidden">
          {/* `now` is resolved on the server and passed down, so the "cooling down"
              badge is the same on both sides of hydration. */}
          <RulesTable rows={rules} now={Date.now()} />
        </Card>

        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Firing history
          </h2>
          <Card className="overflow-hidden">
            <FiringHistory rows={firings} />
          </Card>
        </section>
      </PageBody>
    </>
  );
}
