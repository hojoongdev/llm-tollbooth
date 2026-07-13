/**
 * Every environment knob the gateway reads, resolved once at import.
 *
 * All of them have a working default (the local compose values), so the service
 * runs with an empty .env — and no secret is ever written in source (spec §14).
 */

function int(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function float(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const PORT = int(process.env.PORT, 8080);
export const HOST = process.env.HOST ?? "0.0.0.0";
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

/** Single-tenant until P6: every key and event belongs to the one project. */
export const PROJECT_ID = process.env.PROJECT_ID ?? "default";

export const KAFKA_BOOTSTRAP = process.env.KAFKA_BOOTSTRAP ?? "localhost:9092";
export const KAFKA_TOPIC = process.env.KAFKA_TOPIC ?? "llm.events";

export const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017";
export const MONGO_DB = process.env.MONGO_DB ?? "tollbooth";

// Read-only, and for one purpose: how much a key has already spent (budget.ts).
export const CASSANDRA_CONTACT_POINTS = process.env.CASSANDRA_CONTACT_POINTS ?? "localhost";
export const CASSANDRA_DC = process.env.CASSANDRA_DC ?? "datacenter1";
export const CASSANDRA_KEYSPACE = process.env.CASSANDRA_KEYSPACE ?? "tollbooth";

/** How often the in-memory spend tally is re-checked against the rollups. */
export const BUDGET_RECONCILE_SECONDS = int(process.env.BUDGET_RECONCILE_SECONDS, 20);

/**
 * Response cache TTL. 0 = off, which is the default on purpose: a cache changes
 * what a call means (ask twice at temperature 1 and you are supposed to get two
 * answers), so it is the operator's call to make, not ours.
 */
export const CACHE_TTL_SECONDS = int(process.env.CACHE_TTL_SECONDS, 0);

/**
 * Spec §6. Note this only describes how *humans* get into the console — calls to
 * the gateway always need an API key. `none` means nobody logs in to issue one,
 * so the gateway provisions a default key itself (see keys.ts).
 */
export const AUTH_MODE = process.env.AUTH_MODE ?? "none";

/** Pins that auto-provisioned key across restarts. Empty => a fresh random one. */
export const DEFAULT_KEY = process.env.GATEWAY_DEFAULT_KEY ?? "";

/**
 * Shared secret for /internal — the routes the rest of the stack calls, rather than
 * the ones customers do (routes/admin.ts).
 *
 * Empty turns them off, and that is the right failure: an unauthenticated endpoint
 * anyone can reach is a worse thing to ship than the 30 seconds of staleness it
 * exists to remove. The gateway says so at boot rather than quietly going without.
 */
export const INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? "";

// --- Real providers ---
// A provider with no key configured simply isn't registered, and its models fall
// through to the mock (providers/index.ts). That is what makes "clone it and it
// works" true, and turning on the real thing a one-line .env change.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
/** Any OpenAI-compatible server you host yourself (vLLM, Ollama). URL alone enables it. */
export const SELFHOST_BASE_URL = process.env.SELFHOST_BASE_URL ?? "";
export const SELFHOST_API_KEY = process.env.SELFHOST_API_KEY ?? "";

/** A provider that has stopped answering must not hold our caller's socket open. */
export const PROVIDER_TIMEOUT_MS = int(process.env.PROVIDER_TIMEOUT_MS, 60_000);

// --- Mock provider ---
// The built-in fake LLM that lets the whole stack demo without a provider key.
// Latency is configurable because it is also the baseline we subtract when
// measuring the gateway's own overhead (spec §11): MOCK_LATENCY_MS=0 leaves
// nothing but our own work in the number.
export const MOCK_LATENCY_MS = int(process.env.MOCK_LATENCY_MS, 250);
export const MOCK_JITTER_MS = int(process.env.MOCK_JITTER_MS, 150);
/** 0..1 — injects upstream failures so the error path is demo-able too. */
export const MOCK_ERROR_RATE = float(process.env.MOCK_ERROR_RATE, 0);
