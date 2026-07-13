import { describe, expect, it } from "vitest";

import { computeCost, type Price } from "./pricing.js";
import { estimateTokens } from "./tokens.js";

const gpt4o: Price = {
  _id: "gpt-4o",
  provider: "openai",
  input_per_mtok: 2.5,
  output_per_mtok: 10.0,
};

const selfhosted: Price = {
  _id: "llama-3.1-8b",
  provider: "selfhost",
  input_per_mtok: 0,
  output_per_mtok: 0,
};

const usage = (prompt: number, completion: number) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});

describe("computeCost", () => {
  it("bills input and output at their own separate rates", () => {
    // A million of each: $2.50 in + $10.00 out. Getting this backwards is the
    // classic way to under-bill output, which is where the money actually is.
    expect(computeCost(gpt4o, usage(1_000_000, 1_000_000))).toBe(12.5);
  });

  it("prices a single realistic call", () => {
    // 812 prompt + 214 completion (the example event in spec §7.1):
    //   812 x $2.50/Mtok = $0.00203
    //   214 x $10.00/Mtok = $0.00214
    expect(computeCost(gpt4o, usage(812, 214))).toBe(0.00417);
  });

  it("rounds to micro-dollars — the resolution the rollup counters store", () => {
    // Cassandra counters are integers, so cost rides the pipeline as an integer
    // number of micro-dollars. Anything finer than 1e-6 is lost downstream, so
    // we round here rather than pretending to a precision the storage lacks.
    expect(computeCost(gpt4o, usage(1, 0))).toBe(0.000003); // $0.0000025 -> 3 micro-dollars
  });

  it("rounds a cost that lands exactly on half a micro-dollar", () => {
    // 11 x $2.50 + 35 x $10.00 = 377.5 micro-dollars, so this must round to 378.
    // Computing the dollars first (tokens / 1e6 x price) makes that sum land a
    // hair *under* 377.5 in binary and silently round down instead. A real call
    // through the gateway caught this, which is why the test is here.
    expect(computeCost(gpt4o, usage(11, 35))).toBe(0.000378);
  });

  it("costs nothing for a free self-hosted model", () => {
    expect(computeCost(selfhosted, usage(5_000, 5_000))).toBe(0);
  });

  it("costs nothing for a call that produced no tokens", () => {
    expect(computeCost(gpt4o, usage(0, 0))).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("counts empty text as no tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("never reports zero tokens for text that exists", () => {
    expect(estimateTokens("hi")).toBe(1);
  });

  it("approximates four characters to the token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
