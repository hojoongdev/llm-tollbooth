import { MockProvider } from "./mock.js";
import type { Provider } from "./types.js";

const mock = new MockProvider();

/**
 * Which provider serves this model.
 *
 * Today: the mock, always — it is the fallback whenever no real key is configured
 * for the provider a model belongs to, and right now none are. The real OpenAI /
 * Anthropic adapters slot in here, and the event records whoever actually served
 * the call, so a mock-served `gpt-4o` shows up honestly as provider=mock.
 */
export function resolveProvider(_model: string): Provider {
  return mock;
}
