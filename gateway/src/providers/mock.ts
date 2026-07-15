import { randomUUID } from "node:crypto";

import { MOCK_ERROR_RATE, MOCK_JITTER_MS, MOCK_LATENCY_MS } from "../config.js";
import { GatewayError } from "../errors.js";
import { estimateTokens } from "../tokens.js";
import { deltaChunk, usageChunk } from "./chunks.js";
import type { ChatCompletionChunk, ChatRequest, Provider, ProviderResult } from "./types.js";

/**
 * The built-in fake LLM (spec §5): the stack has to be demo-able and load-testable
 * with no real API key and no money spent.
 *
 * It is deliberately *not* a stub that returns a constant. It burns latency, it
 * produces an answer whose length tracks the prompt, and it counts the tokens of
 * the text it actually produced — so every number the console then shows (cost,
 * tokens, latency, error rate) is real arithmetic over fake inputs rather than a
 * hardcoded figure. The only randomness is in latency and injected failures;
 * the answer itself is deterministic, which is what lets the response cache be
 * demonstrated meaningfully.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FILLER =
  "the model considers the question, weighs the context it was given, and " +
  "returns an answer of a length proportional to what it was asked. ";

export class MockProvider implements Provider {
  readonly name = "mock";

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const prompt = req.messages.map((m) => m.content ?? "").join("\n");
    const promptTokens = estimateTokens(prompt);

    // A longer prompt earns a longer answer (bounded by max_tokens), so bills
    // from the mock have the same shape as bills from a real provider.
    const budget = Math.min(req.max_tokens ?? 512, 32 + Math.round(promptTokens * 0.3));
    const content = buildReply(req.messages, budget);
    const completionTokens = estimateTokens(content);

    // Latency: a fixed floor plus jitter. Setting MOCK_LATENCY_MS=0 removes the
    // fake wait entirely, which is how the gateway's own overhead gets measured.
    const latency = MOCK_LATENCY_MS + Math.round(Math.random() * MOCK_JITTER_MS);
    // Real providers spend most of a non-streaming call generating; first byte
    // arrives well before the last. Model that so TTFB isn't a meaningless copy.
    const ttfb = Math.round(latency * 0.4);

    await sleep(ttfb);
    if (MOCK_ERROR_RATE > 0 && Math.random() < MOCK_ERROR_RATE) {
      throw new GatewayError("provider_error", "mock provider: injected failure", 502);
    }
    await sleep(latency - ttfb);

    return {
      ttfbMs: ttfb,
      response: {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      },
    };
  }

  /**
   * The same fake answer, delivered a piece at a time — so streaming can be demoed
   * and load-tested without a real provider, exactly like chat().
   *
   * The content is built whole and then sliced, so the tokens still describe the
   * text that was actually sent, and the trailing usage chunk carries the real
   * count. The injected failure fires *before the first chunk*, which is what lets
   * the gateway still turn it into a proper HTTP error rather than a torn stream.
   */
  async *stream(req: ChatRequest): AsyncIterable<ChatCompletionChunk> {
    const prompt = req.messages.map((m) => m.content ?? "").join("\n");
    const promptTokens = estimateTokens(prompt);
    const budget = Math.min(req.max_tokens ?? 512, 32 + Math.round(promptTokens * 0.3));
    const content = buildReply(req.messages, budget);
    const completionTokens = estimateTokens(content);

    const latency = MOCK_LATENCY_MS + Math.round(Math.random() * MOCK_JITTER_MS);
    const ttfb = Math.round(latency * 0.4);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    await sleep(ttfb);
    if (MOCK_ERROR_RATE > 0 && Math.random() < MOCK_ERROR_RATE) {
      throw new GatewayError("provider_error", "mock provider: injected failure", 502);
    }

    yield deltaChunk(id, created, req.model, { role: "assistant" });

    const pieces = sliceText(content, 16);
    const gap = pieces.length ? (latency - ttfb) / pieces.length : 0;
    for (const piece of pieces) {
      await sleep(gap);
      yield deltaChunk(id, created, req.model, { content: piece });
    }

    yield deltaChunk(id, created, req.model, {}, "stop");
    yield usageChunk(id, created, req.model, {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    });
  }
}

/** Cut text into roughly `count` contiguous pieces, so a stream arrives in frames
 *  instead of all at once. Reassembling them yields the original exactly. */
function sliceText(text: string, count: number): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / count));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

/** An answer that quotes what it was asked, padded to roughly `budget` tokens. */
function buildReply(messages: ChatRequest["messages"], budget: number): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const quoted = (lastUser?.content ?? "").trim().slice(0, 120);

  let reply = `[mock] You asked: "${quoted}". `;
  const targetChars = budget * 4; // the inverse of estimateTokens()
  while (reply.length < targetChars) reply += FILLER;
  return reply.slice(0, targetChars).trimEnd();
}
