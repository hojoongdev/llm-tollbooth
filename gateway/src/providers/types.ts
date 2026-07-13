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

export interface Provider {
  /** Recorded as `provider` on the event — what actually served the call. */
  readonly name: string;
  chat(req: ChatRequest): Promise<ProviderResult>;
}
