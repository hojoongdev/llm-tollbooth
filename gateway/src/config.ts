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

/**
 * Spec §6. Note this only describes how *humans* get into the console — calls to
 * the gateway always need an API key. `none` means nobody logs in to issue one,
 * so the gateway provisions a default key itself (see keys.ts).
 */
export const AUTH_MODE = process.env.AUTH_MODE ?? "none";

/** Pins that auto-provisioned key across restarts. Empty => a fresh random one. */
export const DEFAULT_KEY = process.env.GATEWAY_DEFAULT_KEY ?? "";

// --- Mock provider ---
// The built-in fake LLM that lets the whole stack demo without a provider key.
// Latency is configurable because it is also the baseline we subtract when
// measuring the gateway's own overhead (spec §11): MOCK_LATENCY_MS=0 leaves
// nothing but our own work in the number.
export const MOCK_LATENCY_MS = int(process.env.MOCK_LATENCY_MS, 250);
export const MOCK_JITTER_MS = int(process.env.MOCK_JITTER_MS, 150);
/** 0..1 — injects upstream failures so the error path is demo-able too. */
export const MOCK_ERROR_RATE = float(process.env.MOCK_ERROR_RATE, 0);
