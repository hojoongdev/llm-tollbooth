import { fmtTs } from "@/lib/format";
import { metricValue, scopeLabel, type FiringRow } from "@/lib/rule-format";
import { Badge } from "@/components/ui/badge";

/**
 * What fired, when, on what, and whether anyone was actually told.
 *
 * That last column is the one that earns its place. An action can fail — an SMTP relay
 * down, a webhook 500ing — and the worker deliberately does not retry, because retrying
 * a broken webhook every twenty seconds would defeat the cooldown. So the failure has
 * to be visible somewhere, and this is somewhere.
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
            <th className="px-3 py-2 text-right font-medium">Observed</th>
            <th className="px-3 py-2 text-right font-medium">Threshold</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id} className="border-b border-border">
              <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted-foreground">
                {fmtTs(new Date(f.firedAt))}
              </td>
              <td className="px-3 py-2 font-medium">
                {f.ruleName}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  {f.metric} · {f.windowHours}h
                </span>
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                {scopeLabel(f.scope)}
              </td>
              {/* The observed value is the point: it says how far past the line things
                  had gone, which is what tells you whether the threshold was set well. */}
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums font-semibold">
                {metricValue(f.metric, f.observed)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {metricValue(f.metric, f.threshold)}
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
