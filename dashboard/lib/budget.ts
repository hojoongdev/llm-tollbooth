import "server-only";

import { keySpendByDay } from "./cassandra";
import { listKeys } from "./keys";

/**
 * How close each budgeted key is to being cut off (spec §4, group A).
 *
 * A budget is a calendar thing, not a "last N hours" thing — so this ignores the range
 * filter on the rest of the Overview and always reads *today* and *this month*, in UTC.
 * Those are the exact windows the gateway enforces against (gateway/src/budget.ts:
 * dayKey / daysOfMonth), and a gauge that measured a different window than the enforcer
 * would be telling someone they have room they do not have.
 */

export interface BurnRow {
  id: string;
  name: string;
  status: "active" | "blocked";
  dailyUsd: number | null;
  monthlyUsd: number | null;
  spentToday: number;
  spentThisMonth: number;
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Every UTC day of the current month up to today — the partitions a monthly cap sums. */
function daysOfMonth(now: Date): string[] {
  const days: string[] = [];
  for (let d = 1; d <= now.getUTCDate(); d++) {
    days.push(dayKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d))));
  }
  return days;
}

export async function budgetBurn(projectId: string, now: Date = new Date()): Promise<BurnRow[]> {
  const budgeted = (await listKeys(projectId)).filter((k) => k.dailyUsd !== null || k.monthlyUsd !== null);
  if (budgeted.length === 0) return [];

  const today = dayKey(now);
  const month = daysOfMonth(now);

  const rows = await Promise.all(
    budgeted.map(async (k) => {
      // Read the month only when a monthly cap exists — same economy the gateway makes.
      const byDay = await keySpendByDay(projectId, k.id, k.monthlyUsd !== null ? month : [today]);

      let spentThisMonth = 0;
      for (const usd of byDay.values()) spentThisMonth += usd;

      return {
        id: k.id,
        name: k.name,
        status: k.status,
        dailyUsd: k.dailyUsd,
        monthlyUsd: k.monthlyUsd,
        spentToday: byDay.get(today) ?? 0,
        spentThisMonth,
      };
    }),
  );

  // Closest to its cap first — that is the only ordering anyone reads this list for.
  const burn = (r: BurnRow) =>
    Math.max(
      r.dailyUsd ? r.spentToday / r.dailyUsd : 0,
      r.monthlyUsd ? r.spentThisMonth / r.monthlyUsd : 0,
    );
  return rows.sort((a, b) => burn(b) - burn(a));
}
