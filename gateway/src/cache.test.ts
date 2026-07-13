import { describe, expect, it } from "vitest";

import { cacheKey } from "./cache.js";
import type { ChatRequest } from "./providers/types.js";

const ask = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What does the tollbooth do?" }],
  ...over,
});

describe("cacheKey", () => {
  it("is the same key for the same request", () => {
    expect(cacheKey(ask())).toBe(cacheKey(ask()));
  });

  it("ignores whitespace the caller happened to leave around a message", () => {
    // Same question, typed with a trailing newline. Treating those as different
    // questions is how a cache ends up with a hit rate of nearly zero.
    const padded = ask({ messages: [{ role: "user", content: "  What does the tollbooth do?\n" }] });
    expect(cacheKey(padded)).toBe(cacheKey(ask()));
  });

  it("ignores the order the fields arrived in", () => {
    // The canonical object is rebuilt field by field, so the client's JSON key
    // order can't fragment the cache.
    const reordered = { messages: ask().messages, model: "gpt-4o" } as ChatRequest;
    expect(cacheKey(reordered)).toBe(cacheKey(ask()));
  });

  it("ignores a label that never reaches the model", () => {
    expect(cacheKey(ask({ feature_tag: "checkout-bot" }))).toBe(cacheKey(ask()));
  });

  it("separates different models", () => {
    expect(cacheKey(ask({ model: "gpt-4o-mini" }))).not.toBe(cacheKey(ask()));
  });

  it("separates anything that changes the answer", () => {
    const base = cacheKey(ask());
    expect(cacheKey(ask({ temperature: 0.2 }))).not.toBe(base);
    expect(cacheKey(ask({ top_p: 0.5 }))).not.toBe(base);
    expect(cacheKey(ask({ max_tokens: 100 }))).not.toBe(base);
    expect(cacheKey(ask({ stop: ["\n"] }))).not.toBe(base);
  });

  it("separates a different conversation", () => {
    const followUp = ask({
      messages: [
        { role: "user", content: "What does the tollbooth do?" },
        { role: "assistant", content: "It meters every call." },
        { role: "user", content: "And if I go over budget?" },
      ],
    });
    expect(cacheKey(followUp)).not.toBe(cacheKey(ask()));
  });

  it("separates the same words said by a different role", () => {
    const asSystem = ask({ messages: [{ role: "system", content: "What does the tollbooth do?" }] });
    expect(cacheKey(asSystem)).not.toBe(cacheKey(ask()));
  });
});
