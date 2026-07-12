import { callUpstream } from "./http.js";
import type { ChatRequest, ChatResponse, Provider, ProviderResult } from "./types.js";

/**
 * OpenAI, and anything that speaks its API — vLLM, Ollama, LM Studio, a hosted
 * gateway (spec §4: "at least three providers", one of them self-hosted).
 *
 * The adapter is thin on purpose. Our own surface *is* the OpenAI surface, so
 * there is nothing to translate: the value of this class is the auth header, the
 * timeout, and the error mapping — not a format conversion that would only be a
 * way to introduce bugs.
 *
 * What we do not do is forward the request verbatim. We rebuild it field by
 * field, because the incoming body carries our own extensions (feature_tag) and
 * anything else a client felt like attaching, and a strict upstream rejects
 * fields it doesn't know.
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const { body, ttfbMs } = await callUpstream<ChatResponse>(
      `${this.baseUrl}/chat/completions`,
      // A self-hosted server often wants no key at all; don't send an empty one.
      this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      toOpenAIRequest(req),
    );

    return { response: body, ttfbMs };
  }
}

/** Pure, so the shape we actually put on the wire can be tested. */
export function toOpenAIRequest(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    })),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.top_p !== undefined && { top_p: req.top_p }),
    ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
    ...(req.stop !== undefined && { stop: req.stop }),
    // Streaming is P5; asking for it here would get us a body we can't parse.
    stream: false,
  };
}
