import { describe, expect, it } from "vitest";

import { estimateTokens } from "../tokens.js";
import { MockProvider } from "./mock.js";

const mock = new MockProvider();

describe("MockProvider", () => {
  it("reports usage for the text it actually produced", async () => {
    // The point of the mock is that the console's numbers are arithmetic over
    // something real, not constants. If usage stopped matching the returned
    // text, every cost figure in the demo would quietly become fiction.
    const { response } = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What does the tollbooth do?" }],
    });

    const answer = response.choices[0]!.message.content;
    expect(response.usage.completion_tokens).toBe(estimateTokens(answer));
    expect(response.usage.total_tokens).toBe(
      response.usage.prompt_tokens + response.usage.completion_tokens,
    );
  });

  it("answers at greater length when asked at greater length", async () => {
    const short = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const long = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x".repeat(4_000) }],
    });

    expect(long.response.usage.completion_tokens).toBeGreaterThan(
      short.response.usage.completion_tokens,
    );
  });

  it("stays within max_tokens", async () => {
    const { response } = await mock.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x".repeat(4_000) }],
      max_tokens: 40,
    });

    expect(response.usage.completion_tokens).toBeLessThanOrEqual(40);
  });

  it("answers in the OpenAI response shape", async () => {
    const { response } = await mock.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });

    expect(response.object).toBe("chat.completion");
    expect(response.model).toBe("gpt-4o-mini");
    expect(response.choices[0]!.message.role).toBe("assistant");
    expect(response.choices[0]!.finish_reason).toBe("stop");
  });
});
