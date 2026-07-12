import { randomUUID } from "node:crypto";

import { callUpstream } from "./http.js";
import type { ChatRequest, ChatResponse, Provider, ProviderResult } from "./types.js";

/**
 * Anthropic's Messages API — the adapter that actually has to translate.
 *
 * Three things differ from OpenAI's shape and each one is a trap:
 *   - the system prompt is not a message, it is a top-level `system` field;
 *   - `max_tokens` is required, not optional;
 *   - the answer arrives as a list of content blocks, not a string.
 * Get any of them wrong and the call fails at the provider, where it costs a
 * round-trip to find out.
 */
const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic will not answer without a ceiling, so we have to pick one. */
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const { body, ttfbMs } = await callUpstream<AnthropicResponse>(
      `${this.baseUrl}/messages`,
      {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      toAnthropicRequest(req),
    );

    return { response: fromAnthropicResponse(body, req.model), ttfbMs };
  }
}

/** Pure — the translation is the risk, so it is the thing under test. */
export function toAnthropicRequest(req: ChatRequest): Record<string, unknown> {
  // System turns are lifted out and concatenated: Anthropic takes one system
  // string, while OpenAI lets a caller sprinkle several system messages about.
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      // Anthropic knows only user and assistant. A tool result has nowhere else
      // to go, so it arrives as user content — which is what it is to the model.
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

  return {
    model: req.model,
    messages,
    ...(system ? { system } : {}),
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.top_p !== undefined && { top_p: req.top_p }),
    ...(req.stop !== undefined && {
      stop_sequences: Array.isArray(req.stop) ? req.stop : [req.stop],
    }),
  };
}

/** Pure. `model` is the one the caller asked for — it is what we price against. */
export function fromAnthropicResponse(res: AnthropicResponse, model: string): ChatResponse {
  const text = res.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  return {
    id: res.id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason(res.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    },
  };
}

function finishReason(stop: string | null): string {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    // end_turn, stop_sequence and anything new all mean "it finished talking".
    default:
      return "stop";
  }
}
