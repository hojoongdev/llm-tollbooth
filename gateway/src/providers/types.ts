/**
 * The slice of the OpenAI chat-completions API the gateway speaks.
 *
 * This shape is the whole point of the product: an app switches to the tollbooth
 * by changing a base URL, so what we accept and return has to be what OpenAI
 * accepts and returns. Provider adapters translate *into* and *out of* these.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  /** Tollbooth extension: labels the call in the console. Also read from the
   *  `X-Tollbooth-Tag` header, which any OpenAI SDK can set without patching. */
  feature_tag?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  usage: Usage;
}

export interface ProviderResult {
  response: ChatResponse;
  /** Upstream time-to-first-byte, when the transport lets us see it. */
  ttfbMs: number | null;
}

/**
 * One frame of a streamed completion, in OpenAI's `chat.completion.chunk` shape —
 * which is what the gateway forwards to the caller verbatim, for the same reason
 * the non-streaming shape is OpenAI's: switching to the tollbooth is a base-URL
 * change, so the bytes on the wire have to be the ones an OpenAI SDK expects.
 *
 * Each adapter's job is to turn its provider's native stream into these.
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
  /**
   * Present only on a trailing chunk, and only when the provider reports it
   * (OpenAI with stream_options.include_usage, Anthropic's message_delta, the mock
   * always). The gateway meters from this when it arrives and counts the streamed
   * text itself when it does not — a stream still has to produce a bill.
   */
  usage?: Usage;
}

export interface Provider {
  /** Recorded as `provider` on the event — what actually served the call. */
  readonly name: string;
  chat(req: ChatRequest): Promise<ProviderResult>;
  /**
   * The streaming counterpart of chat(): yields OpenAI-shaped chunks the gateway
   * pipes straight to the caller, ending with one that carries usage where the
   * provider gives us the numbers to fill it.
   */
  stream(req: ChatRequest): AsyncIterable<ChatCompletionChunk>;
}
