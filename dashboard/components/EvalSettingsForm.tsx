"use client";

import { useActionState } from "react";
import { Save } from "lucide-react";

import { saveEvalSettings, type SettingsState } from "@/app/(app)/settings/actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BUTTON } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import type { EvalSettings } from "@/lib/eval";

/**
 * The knobs the eval worker actually obeys (spec §8 screen 6, §4 group D).
 *
 * They live in Mongo, not in the env that seeds them, so this form changes what the worker
 * does within seconds and without a restart — which is what makes "turn sampling up, watch
 * the Quality screen fill in" a thing you can do while looking at it.
 */
export function EvalSettingsForm({ settings }: { settings: EvalSettings }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(saveEvalSettings, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quality evaluation</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex h-7 items-center gap-1.5 text-xs font-medium">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={settings.enabled}
                className="h-3.5 w-3.5 accent-primary"
              />
              평가 켜기
            </label>

            <Field
              label="샘플링 (%)"
              name="sample_percent"
              type="number"
              step="1"
              min="0"
              max="100"
              required
              defaultValue={Math.round(settings.sampleRate * 100)}
              className="w-32"
            />

            <Field
              label="평가 모델 (judge)"
              name="eval_model"
              type="text"
              required
              defaultValue={settings.evalModel}
              className="w-48"
            />

            <Field
              label="모델 필터 (비우면 전체)"
              name="models"
              type="text"
              defaultValue={settings.models.join(", ")}
              placeholder="gpt-4o, claude-3-5-sonnet"
              className="min-w-52 flex-1"
            />

            <Field
              label="키 필터 (비우면 전체)"
              name="keys"
              type="text"
              defaultValue={settings.keys.join(", ")}
              placeholder="key_abc"
              className="min-w-40 flex-1"
            />
          </div>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending} className={BUTTON}>
              <Save className="h-3.5 w-3.5" strokeWidth={2} />
              {pending ? "저장 중…" : "저장"}
            </button>
            {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
            {state.ok ? <p className="text-xs text-success">{state.ok}</p> : null}
          </div>
        </form>

        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          전수 평가는 호출마다 판정 LLM을 한 번씩 더 부르므로 <strong className="font-medium">샘플링</strong>합니다
          (기본 10%). 판정 모델은 <strong className="font-medium">게이트웨이를 통해</strong> 호출되므로 — 프로바이더 키가
          없으면 mock 이 답합니다 — 그 호출도 비용·지연이 그대로 계측되고, 자기 자신을 다시 채점하지 않도록 태그로
          걸러집니다. 저장하면 재시작 없이 몇 초 안에 적용됩니다.
        </p>
      </CardContent>
    </Card>
  );
}
