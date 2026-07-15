import type { ModelRow } from "@/lib/cassandra";
import { count, usd } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

/**
 * Quality per model, worst first — the comparison the Quality screen exists for (spec §4 D:
 * "모델 간 품질 비교").
 *
 * Cost rides along on purpose. The decision this screen is here to support is "can I move
 * this traffic to the cheaper model", and that question is unanswerable with either number
 * on its own: a model that is 20% cheaper and scores 4.4 against 4.5 is a different
 * proposition from one that scores 2.9.
 *
 * A model with no scored calls is shown, and shown as unscored rather than as a zero. It is
 * the answer to "why is my model not on the chart", and inventing a 0.0 for it would rank a
 * model nobody has judged below one that is genuinely terrible.
 */
export function QualityByModel({ rows }: { rows: ModelRow[] }) {
  const scored = rows.filter((r) => r.scored > 0).sort((a, b) => a.quality - b.quality);
  const unscored = rows.filter((r) => r.scored === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quality by model</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No traffic in this window.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {scored.map((r) => (
              <div key={r.model} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5">
                <div className="w-32 shrink-0 truncate text-sm font-medium sm:w-44">
                  {r.model}
                  {r.provider ? (
                    <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{r.provider}</span>
                  ) : null}
                </div>

                {/* The bar is the score on its own 1–5 scale, not relative to the best model
                    here: 4.6 is a good answer whether or not something else scored 4.8. */}
                <div className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-muted sm:block">
                  <div
                    className={`h-full rounded-full ${r.quality < 3 ? "bg-destructive" : "bg-primary"}`}
                    style={{ width: `${Math.max(2, ((r.quality - 1) / 4) * 100)}%` }}
                  />
                </div>

                <div className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:ml-0">
                  <span className={r.quality < 3 ? "font-semibold text-destructive" : "font-semibold text-foreground"}>
                    {r.quality.toFixed(2)}
                  </span>
                  {" / 5 · "}
                  {count(r.scored)} scored of {count(r.requests)} · {usd(r.cost)}
                </div>
              </div>
            ))}

            {unscored.map((r) => (
              <div key={r.model} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5">
                <div className="w-32 shrink-0 truncate text-sm font-medium text-muted-foreground sm:w-44">
                  {r.model}
                </div>
                <div className="hidden h-1.5 flex-1 rounded-full bg-muted sm:block" />
                <div className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:ml-0">
                  아직 채점된 호출 없음 · {count(r.requests)} req
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
