import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authenticate } from "../auth.js";
import { checkLimits, recordSpend } from "../budget.js";
import { cacheGet, cacheKey, cachePut } from "../cache.js";
import { FALLBACK_MODEL } from "../config.js";
import { errorBody, GatewayError } from "../errors.js";
import type { LlmEvent } from "../event.js";
import { fallbackModelFor, isFallbackWorthy } from "../fallback.js";
import type { ApiKey } from "../keys.js";
import { publishEvent } from "../kafka.js";
import { costOf } from "../pricing.js";
import { resolveProvider } from "../providers/index.js";
import type { ChatRequest, ChatResponse, Provider, Usage } from "../providers/types.js";
import { storeRequest } from "../requests.js";
import { estimateTokens } from "../tokens.js";

/** One link in the try-this-then-that chain: a model and who will serve it. */
interface Attempt {
  model: string;
  provider: Provider;
}

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

    // Who serves this, and who to retry on if they fail (spec §4 B). Built once
    // and shared by both paths; the primary provider is already resolved, so this
    // only ever resolves the fallback.
    const chain = await buildChain(chat.model, provider, key);

    // Streaming takes its own path from here: the answer arrives in frames, so
    // usage is summed as they pass rather than read off a finished response, and
    // the response cache sits it out — it stores whole answers, and is off by
    // default anyway. Everything above (auth, block, budget, rate) applies equally.
    if (chat.stream) {
      return streamCompletion(reply, req, chain, chat, key._id, eventId, startedAt, record);
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

    // Try the primary, then the fallback if there is one. Success on either returns
    // here; only when every attempt has failed do we fall through to the error.
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const attempt = chain[i]!;
      const call = attempt.model === chat.model ? chat : { ...chat, model: attempt.model };
      try {
        const { response, ttfbMs } = await attempt.provider.chat(call);
        const usage = response.usage;
        const cost = await costOf(attempt.model, usage);
        const fellBack = i > 0;

        record({
          status: "success",
          // Whoever actually served it — a fallback attributes cost and tokens to
          // the model that ran, not the one that was asked for.
          provider: attempt.provider.name,
          model: attempt.model,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          cost_usd: cost,
          ttfb_ms: ttfbMs,
        });
        storeRequest(eventId, call, response, null, fellBack ? `fell back from ${chat.model}` : null);
        // Charge it now, not when the rollup catches up — the next call must see it spent.
        recordSpend(key._id, cost);
        // Cache under the model that answered: a fallback answer is a valid answer
        // for the fallback model, and future calls to the primary should still try
        // the primary rather than be handed the substitute.
        cachePut(cacheKey(call), call, response);

        return response;
      } catch (err) {
        lastErr = err;
        if (i < chain.length - 1 && isFallbackWorthy(err)) {
          req.log.warn({ err, from: chat.model, to: chain[i + 1]!.model }, "primary failed; falling back");
          continue;
        }
        break;
      }
    }

    const failure =
      lastErr instanceof GatewayError
        ? lastErr
        : new GatewayError("provider_error", lastErr instanceof Error ? lastErr.message : String(lastErr));

    record({ status: "error", error_type: failure.type });
    storeRequest(eventId, chat, null, failure.message);
    req.log.warn({ err: lastErr, model: chat.model }, "upstream call failed");

    return reply.code(failure.status).send(errorBody(failure.message, "api_error", failure.type));
  });
}

/**
 * The primary provider plus the fallback to retry on, in order. The primary is
 * already resolved by the caller, so this only resolves the fallback — and only
 * when one is configured and it isn't the primary itself (fallback.ts).
 */
async function buildChain(primaryModel: string, primary: Provider, key: ApiKey): Promise<Attempt[]> {
  const chain: Attempt[] = [{ model: primaryModel, provider: primary }];
  const fb = fallbackModelFor(primaryModel, key.fallback_model, FALLBACK_MODEL);
  if (fb) chain.push({ model: fb, provider: await resolveProvider(fb) });
  return chain;
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

/**
 * The streaming half of the toll booth. The same bookkeeping as above — publish an
 * event, store the bodies, charge the budget — but the answer is forwarded frame by
 * frame and usage is summed from those frames (or, when a provider sends no usage
 * frame, counted from the text that went by).
 *
 * Headers are withheld until the first chunk on purpose. A provider that fails
 * before it says anything — unreachable, or the mock's injected failure — still
 * becomes a real HTTP error the client can read, because nothing has reached the
 * wire yet. After the first byte a failure can only be reported in-band, and the
 * stream closed.
 */
async function streamCompletion(
  reply: FastifyReply,
  req: FastifyRequest,
  chain: Attempt[],
  chat: ChatRequest,
  keyId: string,
  eventId: string,
  startedAt: number,
  record: (patch: Partial<LlmEvent>) => void,
): Promise<unknown> {
  const raw = reply.raw;
  // Shared across attempts: once the first byte is out, `started` stays true and
  // there is no more falling back — you cannot un-send a frame.
  let started = false;
  let ttfbMs: number | null = null;

  const begin = (): void => {
    started = true;
    ttfbMs = Math.round(performance.now() - startedAt);
    reply.hijack(); // we own the socket now; Fastify must not also try to answer
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-tollbooth-event-id": eventId,
      "x-tollbooth-cache": "miss",
    });
  };

  for (let i = 0; i < chain.length; i++) {
    const attempt = chain[i]!;
    const call = attempt.model === chat.model ? chat : { ...chat, model: attempt.model };
    let content = "";
    let providerUsage: Usage | null = null;
    let finish = "stop";

    try {
      for await (const chunk of attempt.provider.stream(call)) {
        if (!started) begin();
        const choice = chunk.choices[0];
        if (choice?.delta.content) content += choice.delta.content;
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) providerUsage = chunk.usage;
        raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } catch (err) {
      const failure =
        err instanceof GatewayError
          ? err
          : new GatewayError("provider_error", err instanceof Error ? err.message : String(err));

      // Nothing on the wire yet: a stream that failed before its first byte can
      // still fall back, or — if it can't — become an ordinary HTTP error.
      if (!started) {
        if (i < chain.length - 1 && isFallbackWorthy(err)) {
          req.log.warn(
            { err, from: chat.model, to: chain[i + 1]!.model },
            "primary stream failed before first byte; falling back",
          );
          continue;
        }
        record({ status: "error", error_type: failure.type });
        storeRequest(eventId, call, null, failure.message);
        return reply.code(failure.status).send(errorBody(failure.message, "api_error", failure.type));
      }

      // Mid-stream: the caller already holds a 200 and a partial answer, so there
      // is no retrying. Say so in-band, close, and record what got through.
      const usage = providerUsage ?? countUsage(chat, content);
      record({
        status: "error",
        error_type: failure.type,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        ttfb_ms: ttfbMs,
      });
      storeRequest(
        eventId,
        call,
        buildStreamResponse(eventId, call.model, content, usage, finish),
        `stream_interrupted: ${failure.message}`,
      );
      raw.write(`data: ${JSON.stringify(errorBody(failure.message, "api_error", failure.type))}\n\n`);
      raw.end();
      return undefined;
    }

    // This attempt streamed to completion.
    if (!started) begin(); // it produced no frames, but still owes a clean close
    raw.write("data: [DONE]\n\n");
    raw.end();

    const usage = providerUsage ?? countUsage(chat, content);
    const cost = await costOf(call.model, usage);
    const fellBack = i > 0;
    record({
      status: "success",
      provider: attempt.provider.name,
      model: call.model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cost_usd: cost,
      ttfb_ms: ttfbMs,
    });
    storeRequest(
      eventId,
      call,
      buildStreamResponse(eventId, call.model, content, usage, finish),
      fellBack ? `fell back from ${chat.model}` : null,
    );
    // Charge it now, not when the rollup catches up — the next call must see it spent.
    recordSpend(keyId, cost);
    return undefined;
  }

  return undefined;
}

/**
 * Prompt tokens from the request, completion tokens from the streamed text — the
 * fallback for a provider that sent no usage frame. It mirrors how the mock counts,
 * so a streamed mock call bills identically to a buffered one.
 */
function countUsage(chat: ChatRequest, content: string): Usage {
  const prompt = chat.messages.map((m) => m.content ?? "").join("\n");
  const prompt_tokens = estimateTokens(prompt);
  const completion_tokens = estimateTokens(content);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

/**
 * Reassemble the streamed frames into the same ChatResponse shape the Requests
 * detail already stores and shows, so a streamed call reads back like any other.
 */
function buildStreamResponse(
  eventId: string,
  model: string,
  content: string,
  usage: Usage,
  finish_reason: string,
): ChatResponse {
  return {
    id: `chatcmpl-${eventId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
    usage,
  };
}
