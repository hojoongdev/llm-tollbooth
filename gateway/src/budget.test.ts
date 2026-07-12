import { describe, expect, it } from "vitest";

import { budgetVerdict, takeToken, type Bucket, type Limits } from "./budget.js";

const spend = (dailyUsd: number, monthlyUsd = dailyUsd) => ({ dailyUsd, monthlyUsd });
const noLimits: Limits = { dailyUsd: null, monthlyUsd: null, rpm: null };

describe("budgetVerdict", () => {
  it("lets a key with no budget through", () => {
    expect(budgetVerdict(noLimits, spend(1_000_000)).allowed).toBe(true);
  });

  it("lets a key under its budget through", () => {
    expect(budgetVerdict({ ...noLimits, dailyUsd: 5 }, spend(4.99)).allowed).toBe(true);
  });

  it("blocks a key that has spent exactly its budget", () => {
    // >= not >: $5 spent against a $5 budget *is* spent. Waiting for it to go
    // strictly over would make the last call always the one that breaks the cap.
    const verdict = budgetVerdict({ ...noLimits, dailyUsd: 5 }, spend(5));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe("budget_exceeded");
  });

  it("blocks on the monthly cap even when the day is clear", () => {
    const verdict = budgetVerdict(
      { ...noLimits, dailyUsd: 5, monthlyUsd: 100 },
      { dailyUsd: 0.5, monthlyUsd: 100.2 },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.message).toContain("Monthly");
  });

  it("treats a zero budget as 'allow nothing', not 'no limit'", () => {
    // The console writes null for "no limit". A literal 0 has to mean zero.
    expect(budgetVerdict({ ...noLimits, dailyUsd: 0 }, spend(0)).allowed).toBe(false);
  });
});

describe("takeToken", () => {
  const t0 = 1_700_000_000_000;

  it("spends a token per call and allows a full burst", () => {
    let bucket: Bucket = { tokens: 60, at: t0 };
    for (let i = 0; i < 60; i++) {
      const step = takeToken(bucket, 60, t0);
      expect(step.allowed).toBe(true);
      bucket = step.bucket;
    }
    // 61st call in the same instant: the minute's allowance is gone.
    expect(takeToken(bucket, 60, t0).allowed).toBe(false);
  });

  it("refills continuously rather than in one lump at the window edge", () => {
    // A fixed window would let a caller drain 60 at 11:59:59 and 60 more at
    // 12:00:00. The bucket only gives back what time has actually earned.
    const drained: Bucket = { tokens: 0, at: t0 };

    expect(takeToken(drained, 60, t0 + 500).allowed).toBe(false); // half a second: 0.5 tokens
    expect(takeToken(drained, 60, t0 + 1_000).allowed).toBe(true); // one second: 1 token
  });

  it("never refills past the limit, however long it idles", () => {
    const idle: Bucket = { tokens: 0, at: t0 };
    const after = takeToken(idle, 60, t0 + 3_600_000).bucket; // an hour later
    expect(after.tokens).toBe(59); // capped at 60, minus the token just spent
  });
});
