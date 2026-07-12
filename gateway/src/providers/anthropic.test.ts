import { describe, expect, it } from "vitest";

import { fromAnthropicResponse, toAnthropicRequest, type AnthropicResponse } from "./anthropic.js";
import { inferProviderName } from "./index.js";
import { toOpenAIRequest } from "./openai.js";
import type { ChatRequest } from "./types.js";

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "claude-3-5-sonnet",
  messages: [{ role: "user", content: "Why a tollbooth?" }],
  ...over,
});

describe("toAnthropicRequest", () => {
  it("lifts the system turn out of the messages into its own field", () => {
    // The single most common way to get this wrong: leave it in `messages`,
    // where Anthropic rejects it.
    const out = toAnthropicRequest(
      req({
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "Why a tollbooth?" },
        ],
      }),
    );

    expect(out.system).toBe("Be terse.");
    expect(out.messages).toEqual([{ role: "user", content: "Why a tollbooth?" }]);
  });

  it("joins several system turns, which OpenAI allows and Anthropic does not", () => {
    const out = toAnthropicRequest(
      req({
        messages: [
          { role: "system", content: "Be terse." },
          { role: "system", content: "Cite the spec." },
          { role: "user", content: "Why?" },
        ],
      }),
    );
    expect(out.system).toBe("Be terse.\n\nCite the spec.");
  });

  it("always sends max_tokens, because Anthropic will not answer without one", () => {
    expect(toAnthropicRequest(req()).max_tokens).toBe(1024);
    expect(toAnthropicRequest(req({ max_tokens: 50 })).max_tokens).toBe(50);
  });

  it("renames stop to stop_sequences and always sends a list", () => {
    expect(toAnthropicRequest(req({ stop: "\n" })).stop_sequences).toEqual(["\n"]);
    expect(toAnthropicRequest(req({ stop: ["a", "b"] })).stop_sequences).toEqual(["a", "b"]);
  });

  it("maps a tool turn onto a user turn, the only place it can go", () => {
    const out = toAnthropicRequest(req({ messages: [{ role: "tool", content: "42" }] }));
    expect(out.messages).toEqual([{ role: "user", content: "42" }]);
  });

  it("leaves out what wasn't asked for, rather than sending undefined", () => {
    const out = toAnthropicRequest(req());
    expect("temperature" in out).toBe(false);
    expect("stop_sequences" in out).toBe(false);
  });
});

describe("fromAnthropicResponse", () => {
  const answer: AnthropicResponse = {
    id: "msg_01",
    model: "claude-3-5-sonnet-20241022",
    content: [{ type: "text", text: "Because every call should be metered." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 34 },
  };

  it("flattens the content blocks into the string OpenAI clients expect", () => {
    const out = fromAnthropicResponse(answer, "claude-3-5-sonnet");
    expect(out.choices[0]!.message.content).toBe("Because every call should be metered.");
    expect(out.object).toBe("chat.completion");
  });

  it("keeps only the text blocks", () => {
    const mixed = { ...answer, content: [{ type: "thinking" }, { type: "text", text: "Hi." }] };
    expect(fromAnthropicResponse(mixed, "claude-3-5-sonnet").choices[0]!.message.content).toBe("Hi.");
  });

  it("reports the model the caller asked for — that is what we price", () => {
    // The provider echoes a dated variant (…-20241022) that isn't in our pricing
    // table; billing the answer against a model nobody priced would cost $0.
    expect(fromAnthropicResponse(answer, "claude-3-5-sonnet").model).toBe("claude-3-5-sonnet");
  });

  it("carries usage across, since that is what the call gets billed on", () => {
    expect(fromAnthropicResponse(answer, "claude-3-5-sonnet").usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
    });
  });

  it("translates stop reasons", () => {
    const reason = (stop: string | null) =>
      fromAnthropicResponse({ ...answer, stop_reason: stop }, "m").choices[0]!.finish_reason;

    expect(reason("end_turn")).toBe("stop");
    expect(reason("max_tokens")).toBe("length");
    expect(reason("stop_sequence")).toBe("stop");
    expect(reason(null)).toBe("stop");
  });
});

describe("toOpenAIRequest", () => {
  it("strips our own extensions before they reach a strict upstream", () => {
    const out = toOpenAIRequest(req({ feature_tag: "checkout-bot" }));
    expect("feature_tag" in out).toBe(false);
    expect(out.stream).toBe(false);
  });
});

describe("inferProviderName", () => {
  it("routes a model nobody priced by its name", () => {
    expect(inferProviderName("gpt-4o")).toBe("openai");
    expect(inferProviderName("o3-mini")).toBe("openai");
    expect(inferProviderName("claude-sonnet-5")).toBe("anthropic");
    expect(inferProviderName("mixtral-8x7b")).toBe("selfhost");
  });
});
