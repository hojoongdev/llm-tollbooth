"use client";

import { useActionState, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";

import { issueKey, type NewKeyState } from "@/app/(app)/keys/actions";
import { Card } from "@/components/ui/card";
import { BUTTON, BUTTON_QUIET } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";

export function NewKeyForm() {
  const [state, action, pending] = useActionState<NewKeyState, FormData>(issueKey, {});

  return (
    <Card className="p-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <Field label="Name" name="name" placeholder="checkout-bot" required className="min-w-44 flex-1" />
        <Field label="Daily budget ($)" name="dailyUsd" type="number" step="0.01" min="0" placeholder="none" className="w-32" />
        <Field label="Monthly budget ($)" name="monthlyUsd" type="number" step="0.01" min="0" placeholder="none" className="w-32" />
        <Field label="Rate limit (req/min)" name="rpm" type="number" step="1" min="0" placeholder="none" className="w-32" />
        <button type="submit" disabled={pending} className={BUTTON}>
          <KeyRound className="h-3.5 w-3.5" strokeWidth={2} />
          {pending ? "Issuing…" : "Issue key"}
        </button>
      </form>

      <p className="mt-2 text-[11px] text-muted-foreground">
        빈 칸은 무제한입니다. 키를 차단·수정·폐기하면 게이트웨이 키 캐시를 즉시 비우므로 다음 호출부터 바로 반영됩니다.
      </p>

      {state.error ? <p className="mt-2 text-xs text-destructive">{state.error}</p> : null}
      {state.key ? <IssuedKey value={state.key} /> : null}
    </Card>
  );
}

/**
 * The one and only time the key is readable. We store a hash, so this is not a
 * convenience — nobody, including us, can produce it a second time.
 */
function IssuedKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3">
      <p className="text-xs font-medium">
        Copy it now — only the hash is stored, so this key cannot be shown again.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <button
          type="button"
          className={BUTTON_QUIET}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
