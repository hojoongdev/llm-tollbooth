import { AUTH_MODE, FALLBACK_MODEL, PROJECT, SMTP_FROM, SMTP_HOST, SMTP_PORT } from "@/lib/config";
import { readEvalSettings } from "@/lib/eval";
import { EvalSettingsForm } from "@/components/EvalSettingsForm";
import { PageBody, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * Settings (spec §8 screen 6): the sampling rate, and what the environment is doing.
 *
 * The split is deliberate. The eval settings are editable here because they live in Mongo and
 * the worker re-reads them — so this screen genuinely changes what happens next. Everything
 * below is env, read once at boot by processes this console does not own, and it is shown
 * rather than offered: a form that appeared to set AUTH_MODE and silently did nothing until
 * someone restarted the right container would be worse than no form at all.
 */
export default async function SettingsPage() {
  const settings = await readEvalSettings();

  return (
    <>
      <PageHeader title="Settings" description={`프로젝트 ${PROJECT}`} />

      <PageBody>
        <EvalSettingsForm settings={settings} />

        <Card>
          <CardHeader>
            <CardTitle>Environment</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border">
              <Row
                label="AUTH_MODE"
                value={AUTH_MODE}
                badge={AUTH_MODE === "none" ? "열린 콘솔" : AUTH_MODE === "single" ? "로그인 필요" : AUTH_MODE}
                hint={
                  AUTH_MODE === "none"
                    ? "누구나 콘솔에 들어옵니다. 로컬 데모용 기본값 — 노출된 곳에서는 .env 에 AUTH_MODE=single 과 ADMIN_EMAIL / ADMIN_PASSWORD / SESSION_SECRET 을 넣으세요. 게이트웨이 호출은 이 설정과 무관하게 항상 API 키가 필요합니다."
                    : "콘솔은 로그인해야 들어옵니다. 게이트웨이 호출은 언제나 API 키를 따로 요구합니다."
                }
              />
              <Row
                label="SMTP"
                value={`${SMTP_HOST}:${SMTP_PORT}`}
                badge={SMTP_HOST === "mailpit" ? "Mailpit (로컬)" : "실제 릴레이"}
                hint={
                  SMTP_HOST === "mailpit"
                    ? `규칙의 email 액션은 번들된 Mailpit 으로 갑니다 — 실제로 발송되지 않고 http://localhost:8025 에서 열어봅니다. 보내는 주소는 ${SMTP_FROM}. 실제 릴레이로 바꾸려면 .env 의 SMTP_* 를 채우세요 (SMTP_USER 를 넣는 순간 STARTTLS 가 켜집니다).`
                    : `규칙의 email 액션이 실제로 발송됩니다. 보내는 주소는 ${SMTP_FROM}.`
                }
              />
              <Row
                label="Webhook"
                value="규칙마다 URL 지정"
                badge="Slack · Discord · 일반"
                hint="webhook 액션은 규칙에 적은 URL 로 JSON 을 POST 합니다. 하나의 페이로드에 text(Slack) / content(Discord) / 구조화 필드를 모두 실어 보내므로 벤더별 템플릿이 필요 없습니다."
              />
              <Row
                label="GATEWAY_FALLBACK_MODEL"
                value={FALLBACK_MODEL || "(없음)"}
                badge={FALLBACK_MODEL ? "폴백 켜짐" : "폴백 꺼짐"}
                hint={
                  FALLBACK_MODEL
                    ? `프로바이더가 실패하거나 타임아웃하면 이 모델로 한 번 재시도합니다. 키마다 따로 지정한 폴백이 이 값을 이깁니다. 잘못된 요청(400)은 재시도하지 않습니다 — 모델을 바꿔도 고쳐지지 않으니까요.`
                    : "프로바이더가 실패하면 그대로 오류를 돌려줍니다. .env 에 GATEWAY_FALLBACK_MODEL 을 넣으면 대체 모델로 한 번 재시도합니다 (가격표가 곧 라우팅표라, 다른 프로바이더의 모델이어도 됩니다)."
                }
              />
            </dl>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

function Row({
  label,
  value,
  badge,
  hint,
}: {
  label: string;
  value: string;
  badge: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <dt className="font-mono text-xs font-semibold">{label}</dt>
        <dd className="font-mono text-xs text-muted-foreground">{value}</dd>
        <Badge variant="muted" className="ml-auto">
          {badge}
        </Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
