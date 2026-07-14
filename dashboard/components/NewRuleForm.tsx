"use client";

import { useActionState, useState } from "react";
import { BellRing } from "lucide-react";

import { addRule, type NewRuleState } from "@/app/(app)/rules/actions";
import { Card } from "@/components/ui/card";
import { BUTTON } from "@/components/ui/controls";
import { Field, SelectField } from "@/components/ui/field";
import {
  BUDGET_PERIODS,
  CONDITION_LABEL,
  CONDITIONS,
  KEYWORD_TARGET_LABEL,
  KEYWORD_TARGETS,
  METRIC_LABEL,
  METRIC_UNIT,
  METRICS,
  type ConditionKind,
  type Metric,
} from "@/lib/rule-format";

export interface ScopeOption {
  value: string;
  label: string;
}

export function NewRuleForm({ keys, models }: { keys: ScopeOption[]; models: string[] }) {
  const [state, action, pending] = useActionState<NewRuleState, FormData>(addRule, {});

  // Two pieces of client state, and both earn it. The condition kind decides *which fields
  // exist* — a budget rule has no window and a keyword rule has no threshold — and the
  // metric decides what "over 5" is five *of*.
  const [kind, setKind] = useState<ConditionKind>("metric_threshold");
  const [metric, setMetric] = useState<Metric>("cost");

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name" name="name" placeholder="Hourly spend spike" required className="min-w-44 flex-1" />

          <SelectField
            label="When"
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ConditionKind)}
            className="w-48"
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABEL[c]}
              </option>
            ))}
          </SelectField>

          {/* The scope select offers exactly the dims the rollup has, because a rule's scope
              *is* a rollup dim — one that has never seen traffic has no row to read, and
              would be a rule that can never fire. */}
          <SelectField label="Scope" name="scope" defaultValue="all" className="min-w-40">
            <option value="all">All traffic</option>
            {models.length > 0 ? (
              <optgroup label="Model">
                {models.map((m) => (
                  <option key={m} value={`model:${m}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {keys.length > 0 ? (
              <optgroup label="API key">
                {keys.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </SelectField>

          {kind === "metric_threshold" ? (
            <>
              <SelectField
                label="Metric"
                name="metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value as Metric)}
                className="w-36"
              >
                {METRICS.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </option>
                ))}
              </SelectField>

              <SelectField label="Window" name="window_hours" defaultValue="1" className="w-28">
                <option value="1">Last 1h</option>
                <option value="24">Last 24h</option>
              </SelectField>

              <Field
                label={`Over (${METRIC_UNIT[metric]})`}
                name="threshold"
                type="number"
                step="any"
                min="0"
                required
                placeholder={metric === "error_rate" ? "0.05" : "5"}
                className="w-32"
              />
            </>
          ) : null}

          {kind === "budget_percent" ? (
            <>
              <SelectField label="Budget" name="period" defaultValue="daily" className="w-32">
                {BUDGET_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </SelectField>

              <Field
                label="Reaches (%)"
                name="percent"
                type="number"
                step="1"
                min="1"
                required
                defaultValue={80}
                className="w-32"
              />
            </>
          ) : null}

          {kind === "keyword_match" ? (
            <>
              <Field
                label="Keyword"
                name="keyword"
                type="text"
                required
                placeholder="password"
                className="w-44"
              />

              <SelectField label="Look in" name="matched_in" defaultValue="either" className="w-44">
                {KEYWORD_TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {KEYWORD_TARGET_LABEL[t]}
                  </option>
                ))}
              </SelectField>
            </>
          ) : null}

          {kind === "quality_drop" ? (
            <>
              {/* 24h by default, unlike a threshold rule's 1h: eval samples, so an hour of
                  ordinary traffic may hold only a handful of scores — and an average needs
                  more than a handful to mean anything. */}
              <SelectField label="Window" name="window_hours" defaultValue="24" className="w-28">
                <option value="1">Last 1h</option>
                <option value="24">Last 24h</option>
              </SelectField>

              <Field
                label="Below (1–5)"
                name="min_score"
                type="number"
                step="0.1"
                min="1"
                max="5"
                required
                defaultValue={3.5}
                className="w-32"
              />

              <Field
                label="Min scored"
                name="min_samples"
                type="number"
                step="1"
                min="1"
                required
                defaultValue={5}
                className="w-32"
              />
            </>
          ) : null}

          <Field
            label="Cooldown (min)"
            name="cooldown_minutes"
            type="number"
            step="1"
            min="0"
            defaultValue={30}
            className="w-32"
          />
        </div>

        <fieldset className="flex flex-col gap-2 border-t border-border pt-3">
          <legend className="sr-only">Actions</legend>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Then
          </span>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Check name="use_email" label="Email">
              <input name="email_to" type="email" placeholder="ops@example.com" className={FIELD} />
            </Check>

            <Check name="use_webhook" label="Webhook">
              <input name="webhook_url" type="url" placeholder="https://hooks.slack.com/…" className={`${FIELD} w-56`} />
            </Check>

            <Check name="use_block" label="Block the key" />

            <Check name="use_tag" label="Tag the requests">
              <input name="tag_value" type="text" placeholder="cost-spike" className={`${FIELD} w-32`} />
            </Check>
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={BUTTON}>
            <BellRing className="h-3.5 w-3.5" strokeWidth={2} />
            {pending ? "Arming…" : "Add rule"}
          </button>
          {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
          {state.ok ? <p className="text-xs text-success">{state.ok}</p> : null}
        </div>
      </form>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        <Hint kind={kind} />
      </p>
    </Card>
  );
}

function Hint({ kind }: { kind: ConditionKind }) {
  if (kind === "budget_percent") {
    return (
      <>
        예산은 시간 창이 아니라 <strong className="font-medium">달력</strong> 기준입니다 — &ldquo;오늘&rdquo;은 UTC 하루
        전체이고, 게이트웨이가 실제로 차단할 때 보는 값과 같은 숫자를 읽습니다. 키 범위 규칙에서만 동작합니다.
      </>
    );
  }
  if (kind === "keyword_match") {
    return (
      <>
        키워드는 롤업이 답할 수 없는 유일한 조건이라 <strong className="font-medium">요청 문서를 직접 열어봅니다</strong>{" "}
        — 따라서 게이트웨이를 실제로 통과한 호출에만 걸립니다 (loadgen 합성 이벤트에는 본문이 없습니다). 대소문자는
        구분하지 않습니다. 태그 액션은 창 전체가 아니라 <strong className="font-medium">걸린 그 요청 하나</strong>에만
        붙습니다.
      </>
    );
  }
  if (kind === "quality_drop") {
    return (
      <>
        평가는 <strong className="font-medium">샘플링</strong>이라, 평균은 채점된 호출 수로 나눕니다 (전체 요청 수가
        아니라). 그래서 <strong className="font-medium">채점 건수가 최소치에 못 미치면 발화하지 않습니다</strong> — 한
        건 채점된 답이 2점이라고 새벽에 사람을 깨우는 건 신호가 아니라 잡음입니다. 채점이 하나도 없는 창도 마찬가지로
        조용합니다 (0점이 아니라 &ldquo;모름&rdquo;이니까요). Settings 에서 샘플링 비율을 올리면 더 빨리 쌓입니다.
      </>
    );
  }
  return (
    <>
      규칙은 이벤트 하나가 아니라 <strong className="font-medium">시간 창</strong>을 봅니다 — 롤업이 시간 단위라
      &ldquo;최근 1시간&rdquo;은 직전 시간대까지 걸칩니다. 차단(block)은 키 범위 규칙에서만 동작합니다.
    </>
  );
}

const FIELD =
  "h-7 rounded-md border border-border bg-background px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

function Check({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs font-medium">
        <input type="checkbox" name={name} className="h-3.5 w-3.5 accent-primary" />
        {label}
      </label>
      {children}
    </div>
  );
}
