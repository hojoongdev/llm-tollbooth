import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { authenticate } from "../auth.js";
import { checkLimits, recordSpend } from "../budget.js";
import { cacheGet, cacheKey, cachePut } from "../cache.js";
import { errorBody, GatewayError } from "../errors.js";
import type { LlmEvent } from "../event.js";
import { publishEvent } from "../kafka.js";
import { costOf } from "../pricing.js";
import { resolveProvider } from "../providers/index.js";
import type { ChatRequest } from "../providers/types.js";
import { storeRequest } from "../requests.js";

const ENDPOINT = "/v1/chat/completions";

/**
 * The toll booth itself: authenticate the caller, hand the call to a provider,
 * return the answer — and record what it cost on the way out.
 *
 * The recording never blocks the answer. `publishEvent` does not await the
 * broker, so the only work on the response's critical path is building the
 * envelope (spec §3.1, §14).
 */
export function registerChat(app: FastifyInstance): void {
  app.post(ENDPOINT, { preHandler: authenticate }, async (req, reply) => {
    const key = req.apiKey!;
    const body = req.body as Partial<ChatRequest> | undefined;

    // A malformed body never became an LLM call, so it isn't metered — there is
    // no model, no provider and no cost to attribute it to. It's a client bug,
    // and it gets a client-shaped 400.
    const invalid = validate(body);
    if (invalid) return reply.code(400).send(invalid);

    const chat = body as ChatRequest;
    // Reads the pricing table, which is cached in memory — the routing decision
    // does not cost a database round-trip.
    const provider = await resolveProvider(chat.model);
    const eventId = randomUUID();
    const startedAt = performance.now();

    // Every path out of here past this point publishes an event — including the
    // ones that never reach a provider. A call the tollbooth *refused* is
    // exactly the kind of call its owner needs to see.
    const record = (patch: Partial<LlmEvent>): void =>
      publishEvent({
        event_id: eventId,
        ts: new Date().toISOString(),
        project_id: key.project_id,
        api_key_id: key._id,
        // Whoever would have served it, so a rejected call still shows up under
        // the right provider in the breakdowns.
        provider: provider.name,
        model: chat.model,
        endpoint: ENDPOINT,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_usd: 0,
        latency_ms: Math.round(performance.now() - startedAt),
        ttfb_ms: null,
        status: "error",
        cache_hit: false,
        error_type: null,
        // The bodies live in Mongo `requests` under this same id — the metrics
        // and the text they describe converge on one document.
        request_doc_id: eventId,
        feature_tag: featureTag(req, chat),
        ...patch,
      });

    // Keep the prompt of any refused call: "what was this key trying to do when
    // it got cut off?" is the first question its owner asks.
    if (key.status === "blocked") {
      record({ status: "blocked", error_type: "key_blocked" });
      storeRequest(eventId, chat, null, "blocked: key_blocked");
      return reply
        .code(403)
        .send(errorBody("This API key is blocked.", "invalid_request_error", "key_blocked"));
    }

    // Out of money, or going too fast. Both are decided from memory — no database
    // sits between the caller and their answer (spec §14).
    const verdict = checkLimits(key);
    if (!verdict.allowed) {
      record({ status: "blocked", error_type: verdict.reason });
      storeRequest(eventId, chat, null, `blocked: ${verdict.reason}`);
      return reply
        .code(429)
        .send(
          errorBody(
            verdict.message,
            verdict.reason === "rate_limited" ? "rate_limit_error" : "insufficient_quota",
            verdict.reason,
          ),
        );
    }

    // Served from the cache, if we've answered this exact question before. It is
    // recorded like any other call — tokens and all — but at zero cost, because
    // nothing was bought. That is what makes the cache's value legible in the
    // console rather than showing up as traffic that mysteriously vanished.
    // The caller gets told which call this was, and whether they paid for it.
    // The event id is what they'd search for in the console; the cache header is
    // the convention every CDN and proxy already uses, so tooling understands it
    // for free — and it is how loadgen counts hits when measuring the cache.
    void reply.header("x-tollbooth-event-id", eventId);

    const cacheId = cacheKey(chat);
    const cached = await cacheGet(cacheId);
    if (cached) {
      record({
        status: "cached",
        cache_hit: true,
        prompt_tokens: cached.usage.prompt_tokens,
        completion_tokens: cached.usage.completion_tokens,
        cost_usd: 0,
        latency_ms: Math.round(performance.now() - startedAt),
      });
      storeRequest(eventId, chat, cached, null);
      void reply.header("x-tollbooth-cache", "hit");
      return cached;
    }
    void reply.header("x-tollbooth-cache", "miss");

    try {
      const { response, ttfbMs } = await provider.chat(chat);
      const usage = response.usage;
      const cost = await costOf(chat.model, usage);

      record({
        status: "success",
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        cost_usd: cost,
        latency_ms: Math.round(performance.now() - startedAt),
        ttfb_ms: ttfbMs,
      });
      storeRequest(eventId, chat, response, null);
      // Charge it against the budget now, not when the rollup catches up — the
      // very next call has to see this money as already spent.
      recordSpend(key._id, cost);
      cachePut(cacheId, chat, response);

      return response;
    } catch (err) {
      const failure =
        err instanceof GatewayError
          ? err
          : new GatewayError("provider_error", err instanceof Error ? err.message : String(err));

      record({ status: "error", error_type: failure.type });
      storeRequest(eventId, chat, null, failure.message);
      req.log.warn({ err, model: chat.model }, "upstream call failed");

      return reply.code(failure.status).send(errorBody(failure.message, "api_error", failure.type));
    }
  });
}

function validate(body: Partial<ChatRequest> | undefined) {
  if (!body || typeof body !== "object") {
    return errorBody("Request body must be a JSON object.", "invalid_request_error", "invalid_body");
  }
  if (typeof body.model !== "string" || !body.model) {
    return errorBody("'model' is required.", "invalid_request_error", "missing_model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorBody("'messages' must be a non-empty array.", "invalid_request_error", "missing_messages");
  }
  if (body.stream) {
    // Honest rather than silently non-streaming: usage accounting over a stream
    // is its own problem, and it is scheduled for P5.
    return errorBody(
      "Streaming is not supported yet — send stream=false.",
      "invalid_request_error",
      "stream_unsupported",
    );
  }
  return null;
}

/**
 * The label this call shows up under in the console. A header keeps it out of
 * the OpenAI request body, so any stock SDK can set it (they all allow extra
 * headers); the body field is there for clients that find that easier.
 */
function featureTag(req: FastifyRequest, chat: ChatRequest): string | null {
  const header = req.headers["x-tollbooth-tag"];
  const tag = (Array.isArray(header) ? header[0] : header) ?? chat.feature_tag;
  return tag?.trim() || null;
}
