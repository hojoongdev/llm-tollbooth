import type { FastifyBaseLogger } from "fastify";

import { collection } from "./mongo.js";
import type { ChatMessage, ChatRequest, ChatResponse } from "./providers/types.js";

/**
 * The prompt and the answer, kept so the console's request detail has something
 * to open (spec §4, group A).
 *
 * They live in Mongo `requests` under the *event id*, which is also the key the
 * ingest worker upserts its metrics under. Two writers, one document, disjoint
 * fields, both `$set` upserts — so they converge in either order and neither has
 * to know whether the other has run yet. (This is why the worker cannot use
 * ReplaceOne: it would delete the bodies it knows nothing about.)
 *
 * Bodies are what makes this collection grow, which is what the TTL index on
 * `ts` is for — the worker owns that index, so its expiry is defined in one place.
 */
export interface RequestDoc {
  _id: string;
  ts: Date;
  request: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  };
  response: { id: string; content: string; finish_reason: string } | null;
  error: string | null;
}

let log: FastifyBaseLogger;

export function initRequests(logger: FastifyBaseLogger): void {
  log = logger;
}

/**
 * Store one call's bodies, fire-and-forget.
 *
 * Same rule as event publishing: the caller already has their answer, and no
 * bookkeeping of ours is allowed to delay it or take it away (spec §14). A write
 * that fails costs a detail page its text, nothing more.
 */
export function storeRequest(
  eventId: string,
  chat: ChatRequest,
  response: ChatResponse | null,
  error: string | null,
): void {
  const doc: Omit<RequestDoc, "_id"> = {
    ts: new Date(),
    request: {
      model: chat.model,
      messages: chat.messages,
      ...(chat.temperature !== undefined && { temperature: chat.temperature }),
      ...(chat.top_p !== undefined && { top_p: chat.top_p }),
      ...(chat.max_tokens !== undefined && { max_tokens: chat.max_tokens }),
    },
    response: response
      ? {
          id: response.id,
          content: response.choices[0]?.message.content ?? "",
          finish_reason: response.choices[0]?.finish_reason ?? "stop",
        }
      : null,
    error,
  };

  collection<RequestDoc>("requests")
    .updateOne({ _id: eventId }, { $set: doc }, { upsert: true })
    .catch((err) => log.warn({ err, event_id: eventId }, "could not store request bodies"));
}
