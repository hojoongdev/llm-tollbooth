"use client";

import { Ban, CircleCheck, Save, Trash2 } from "lucide-react";

import { revokeKey, toggleKey, updateLimits } from "@/app/(app)/keys/actions";
import { fmtTs } from "@/lib/format";
import type { KeyRow } from "@/lib/keys";
import { Badge } from "@/components/ui/badge";
import { BUTTON_QUIET } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";

export function KeysTable({ rows }: { rows: KeyRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No keys yet. Issue one above — the gateway rejects every call without one.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((k) => (
        <li key={k.id} className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{k.name}</span>
            <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
            <Badge variant={k.status === "active" ? "success" : "destructive"}>{k.status}</Badge>
            <span className="text-[11px] text-muted-foreground">
              <code className="font-mono">{k.id}</code> · issued {fmtTs(new Date(k.createdAt))}
            </span>

            <div className="ml-auto flex items-center gap-2">
              {/* Separate forms, side by side — a form inside a form is not a thing. */}
              <form action={toggleKey}>
                <input type="hidden" name="id" value={k.id} />
                <input type="hidden" name="status" value={k.status} />
                <button type="submit" className={BUTTON_QUIET}>
                  {k.status === "active" ? (
                    <>
                      <Ban className="h-3.5 w-3.5" strokeWidth={2} /> Block
                    </>
                  ) : (
                    <>
                      <CircleCheck className="h-3.5 w-3.5" strokeWidth={2} /> Unblock
                    </>
                  )}
                </button>
              </form>

              <form action={revokeKey}>
                <input type="hidden" name="id" value={k.id} />
                <button
                  type="submit"
                  className={`${BUTTON_QUIET} hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive`}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={2} /> Revoke
                </button>
              </form>
            </div>
          </div>

          <form action={updateLimits} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={k.id} />
            <Field
              label="Daily budget ($)"
              name="dailyUsd"
              type="number"
              step="0.01"
              min="0"
              defaultValue={k.dailyUsd ?? ""}
              placeholder="none"
              className="w-32"
            />
            <Field
              label="Monthly budget ($)"
              name="monthlyUsd"
              type="number"
              step="0.01"
              min="0"
              defaultValue={k.monthlyUsd ?? ""}
              placeholder="none"
              className="w-32"
            />
            <Field
              label="Rate limit (req/min)"
              name="rpm"
              type="number"
              step="1"
              min="0"
              defaultValue={k.rpm ?? ""}
              placeholder="none"
              className="w-32"
            />
            <button type="submit" className={BUTTON_QUIET}>
              <Save className="h-3.5 w-3.5" strokeWidth={2} /> Save limits
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
