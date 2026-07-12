import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  SELFHOST_API_KEY,
  SELFHOST_BASE_URL,
} from "../config.js";
import { providerForModel } from "../pricing.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { Provider } from "./types.js";

const mock = new MockProvider();

/**
 * Who serves a model, and whether we can actually reach them.
 *
 * A provider with no credentials configured is not an error — it silently
 * becomes the mock. That single property is what lets someone clone this repo
 * and watch the whole system work (costs, budgets, dashboards, cache) without an
 * LLM account, then switch to the real thing by adding one environment variable.
 * The event records whoever *actually* served the call, so a mock-served gpt-4o
 * says provider=mock rather than quietly claiming to be OpenAI.
 */
const configured = new Map<string, Provider>();

if (OPENAI_API_KEY) {
  configured.set("openai", new OpenAICompatibleProvider("openai", OPENAI_BASE_URL, OPENAI_API_KEY));
}
if (ANTHROPIC_API_KEY) {
  configured.set("anthropic", new AnthropicProvider(ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY));
}
// A self-hosted OpenAI-compatible server (vLLM, Ollama, LM Studio) usually wants
// no key at all, so its base URL alone is what turns it on.
if (SELFHOST_BASE_URL) {
  configured.set("selfhost", new OpenAICompatibleProvider("selfhost", SELFHOST_BASE_URL, SELFHOST_API_KEY));
}

export const configuredProviders = (): string[] => [...configured.keys()];

/**
 * Fallback routing for a model nobody has priced. The pricing table is the real
 * routing table (below); this only catches what isn't in it.
 */
export function inferProviderName(model: string): string {
  const m = model.toLowerCase();
  if (/^(gpt|o\d|chatgpt|text-|davinci)/.test(m)) return "openai";
  if (m.startsWith("claude")) return "anthropic";
  return "selfhost";
}

/**
 * The pricing table already has to know who owns each model, in order to price
 * it — so it *is* the routing table, rather than a second list to keep in sync
 * with the first. Editing a model's provider in the console reroutes it.
 */
export async function resolveProvider(model: string): Promise<Provider> {
  const name = (await providerForModel(model)) ?? inferProviderName(model);
  return configured.get(name) ?? mock;
}
