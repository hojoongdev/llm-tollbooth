import { callUpstream, openUpstreamStream, sseEvents } from "./http.js";
import type {
  ChatCompletionChunk,
  ChatRequest,
  ChatResponse,
  Provider,
  ProviderResult,
} from "./types.js";

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

  /**
   * OpenAI's stream is already the wire shape we forward, so this adapter barely
   * translates: it asks for usage on the stream (stream_options.include_usage,
   * which puts a final usage frame on the wire) and passes each parsed chunk
   * straight through. `[DONE]` is OpenAI's terminator, not a chunk, so it ends us.
   */
  async *stream(req: ChatRequest): AsyncIterable<ChatCompletionChunk> {
    const res = await openUpstreamStream(
      `${this.baseUrl}/chat/completions`,
      this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      { ...toOpenAIRequest(req, true), stream_options: { include_usage: true } },
    );

    for await (const { data } of sseEvents(res)) {
      if (data === "[DONE]") return;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch {
        continue; // a keep-alive or a frame we don't recognise
      }
      yield chunk;
    }
  }
}

/** Pure, so the shape we actually put on the wire can be tested. */
export function toOpenAIRequest(req: ChatRequest, stream = false): Record<string, unknown> {
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
    stream,
  };
}
