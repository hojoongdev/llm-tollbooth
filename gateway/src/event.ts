/**
 * The `llm.events` envelope (spec §7.1) — one per call through the gateway.
 *
 * This is a contract, not an internal type: the Python ingest worker parses
 * exactly these field names, so the snake_case is deliberate. Everything the
 * dashboard shows is derived from this envelope.
 */
export type EventStatus = "success" | "error" | "cached" | "blocked";

export interface LlmEvent {
  event_id: string;
  ts: string;
  project_id: string;
  api_key_id: string;
  provider: string;
  model: string;
  endpoint: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  latency_ms: number;
  ttfb_ms: number | null;
  status: EventStatus;
  cache_hit: boolean;
  error_type: string | null;
  /** The Mongo `requests` doc holding the prompt/response bodies (= event_id). */
  request_doc_id: string | null;
  feature_tag: string | null;
}
