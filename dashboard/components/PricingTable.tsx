"use client";

import { useActionState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";

import { removePrice, savePrice, updatePrice, type PriceState } from "@/app/(app)/pricing/actions";
import type { PriceRow } from "@/lib/pricing";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BUTTON, BUTTON_QUIET } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";

export function NewPriceForm() {
  const [state, action, pending] = useActionState<PriceState, FormData>(savePrice, {});

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <Field label="Model" name="model" placeholder="gpt-4.1-mini" required className="min-w-44 flex-1" />
        <Field label="Provider" name="provider" placeholder="openai" required className="w-36" />
        <Field label="Input $ / Mtok" name="inputPerMtok" type="number" step="0.01" min="0" defaultValue="0" className="w-32" />
        <Field label="Output $ / Mtok" name="outputPerMtok" type="number" step="0.01" min="0" defaultValue="0" className="w-32" />
        <button type="submit" disabled={pending} className={BUTTON}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {pending ? "Saving…" : "Add model"}
        </button>
      </form>

      <p className="mt-2 text-[11px] text-muted-foreground">
        가격은 <span className="font-mono">백만 토큰당 USD</span> — 프로바이더가 고시하는 단위 그대로입니다. provider 값은 게이트웨이의{" "}
        <span className="font-medium">라우팅 대상</span>이기도 합니다. 게이트웨이는 이 표를 60초간 캐시합니다.
      </p>

      {state.error ? <p className="mt-2 text-xs text-destructive">{state.error}</p> : null}
      {state.saved ? (
        <p className="mt-2 text-xs text-success">
          Saved <span className="font-mono">{state.saved}</span>.
        </p>
      ) : null}
    </Card>
  );
}

export function PricingTable({ rows }: { rows: PriceRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No models priced. Calls will still be metered — at $0.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.model} className="flex flex-wrap items-end gap-3 px-4 py-3">
          <div className="flex min-w-44 flex-1 flex-col gap-1">
            <span className="font-mono text-sm font-medium">{r.model}</span>
            <Badge variant="muted" className="w-fit">
              {r.provider}
            </Badge>
          </div>

          <form action={updatePrice} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="model" value={r.model} />
            <Field label="Provider" name="provider" defaultValue={r.provider} className="w-36" />
            <Field
              label="Input $ / Mtok"
              name="inputPerMtok"
              type="number"
              step="0.01"
              min="0"
              defaultValue={r.inputPerMtok}
              className="w-32"
            />
            <Field
              label="Output $ / Mtok"
              name="outputPerMtok"
              type="number"
              step="0.01"
              min="0"
              defaultValue={r.outputPerMtok}
              className="w-32"
            />
            <button type="submit" className={BUTTON_QUIET}>
              <Save className="h-3.5 w-3.5" strokeWidth={2} /> Save
            </button>
          </form>

          <form action={removePrice}>
            <input type="hidden" name="model" value={r.model} />
            <button
              type="submit"
              className={`${BUTTON_QUIET} hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive`}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2} /> Remove
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
