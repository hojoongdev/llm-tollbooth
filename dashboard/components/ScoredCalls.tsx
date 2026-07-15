import Link from "next/link";

import type { ScoredRow } from "@/lib/eval";
import { ago } from "@/lib/format";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

/**
 * The judged calls, worst first — and worst first is the point.
 *
 * A list sorted by time would lead with the most recent 4.7 and bury the 1.3 that is the
 * reason to have a quality screen at all. Nobody opens this page to read a good answer.
 *
 * Each row links to the request detail, because the score is a claim and the prompt and the
 * response are the evidence for it. A quality number you cannot click through to the text it
 * describes is a number you have to take on faith.
 */
export function ScoredCalls({ rows }: { rows: ScoredRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lowest scoring calls</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            아직 채점된 호출이 없습니다.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/requests/${r.id}`}
                  className="-mx-2 flex flex-col gap-1 rounded-md px-2 py-2.5 transition-colors hover:bg-accent"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={r.overall < 3 ? "destructive" : r.overall < 4 ? "warning" : "success"}>
                      {r.overall.toFixed(2)} / 5
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">{r.model}</span>
                    <span className="text-[11px] text-muted-foreground">{ago(r.ts)}</span>

                    {/* The three axes, so a low score says *why* it is low without a click.
                        Risk is shown as the judge scored it (5 = very likely made up), which is
                        the one axis where a high number is bad — hence the label. */}
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                      rel {r.relevance} · risk {r.hallucinationRisk} · tone {r.tone}
                    </span>
                  </div>

                  <p className="truncate text-xs text-foreground">{r.prompt || "—"}</p>
                  {r.reason ? (
                    <p className="truncate text-[11px] italic text-muted-foreground">
                      “{r.reason}” — {r.judge}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
