import Link from "next/link";

import { fmtTs } from "@/lib/format";
import { scopeLabel, type FiringRow } from "@/lib/rule-format";
import { Badge } from "@/components/ui/badge";

/**
 * What fired, when, on what — and whether anyone was actually told.
 *
 * That last column earns its place. An action can fail (an SMTP relay down, a webhook
 * 500ing) and the worker deliberately does not retry it, because retrying a broken webhook
 * every twenty seconds would defeat the cooldown. So the failure has to be visible
 * somewhere, and this is somewhere.
 *
 * The "what tripped it" column prints the sentence the *worker* wrote when it fired, rather
 * than reassembling one here. Three condition types describe themselves with three different
 * sets of fields, and a second implementation of that sentence would eventually disagree with
 * the first — and the console would be the one that was wrong.
 */
export function FiringHistory({ rows }: { rows: FiringRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Nothing has fired. That is either good news or a threshold nobody can reach.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 font-medium">Fired (UTC)</th>
            <th className="px-3 py-2 font-medium">Rule</th>
            <th className="px-3 py-2 font-medium">Scope</th>
            <th className="px-3 py-2 font-medium">What tripped it</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id} className="border-b border-border">
              <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted-foreground">
                {fmtTs(new Date(f.firedAt))}
              </td>
              <td className="px-3 py-2 font-medium">{f.ruleName}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                {scopeLabel(f.scope)}
              </td>
              <td className="px-3 py-2">
                <span className="font-mono tabular-nums">{f.detail}</span>
                {/* A keyword rule tripped on one specific call. The first thing anyone wants
                    is to go and read it, so make that one click. */}
                {f.requestId ? (
                  <Link
                    href={`/requests/${f.requestId}`}
                    className="ml-2 text-primary underline-offset-2 hover:underline"
                  >
                    open the request →
                  </Link>
                ) : null}
              </td>
              <td className="px-3 py-2">
                {f.actions.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="flex flex-wrap items-center gap-1">
                    {f.actions.map((a, i) => (
                      <Badge
                        key={`${a.type}-${i}`}
                        variant={a.ok ? "success" : "destructive"}
                        title={a.detail}
                      >
                        {a.type}
                        {a.ok ? null : " failed"}
                      </Badge>
                    ))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
