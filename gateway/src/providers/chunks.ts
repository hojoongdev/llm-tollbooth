import type { ChatCompletionChunk, Usage } from "./types.js";

/**
 * Builders for the OpenAI streaming chunks the gateway forwards. The mock and the
 * Anthropic adapter both synthesize their stream out of these; the OpenAI adapter
 * doesn't, because its upstream already speaks in exactly this shape.
 */

/** A content/role frame: one delta, no usage. */
export function deltaChunk(
  id: string,
  created: number,
  model: string,
  delta: { role?: "assistant"; content?: string },
  finish_reason: string | null = null,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

/**
 * The trailing usage frame. Its `choices` are empty, which is exactly what OpenAI
 * sends with stream_options.include_usage — a client that reads deltas ignores it,
 * and the gateway reads the usage off it to bill the call.
 */
export function usageChunk(
  id: string,
  created: number,
  model: string,
  usage: Usage,
): ChatCompletionChunk {
  return { id, object: "chat.completion.chunk", created, model, choices: [], usage };
}
