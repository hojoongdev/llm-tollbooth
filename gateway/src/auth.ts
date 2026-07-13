import type { FastifyReply, FastifyRequest } from "fastify";

import { errorBody } from "./errors.js";
import { lookupKey, type ApiKey } from "./keys.js";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: ApiKey;
  }
}

/**
 * Bearer-token auth on every gateway call (spec §6) — identity only.
 *
 * Whether an identified key is *allowed* to make this call (blocked, over
 * budget, rate limited) is decided in the route, not here: those rejections have
 * to be recorded as events, and the event needs the model out of the body to be
 * worth anything.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    await reply
      .code(401)
      .send(
        errorBody(
          "Missing API key. Pass it as: Authorization: Bearer <key>",
          "invalid_request_error",
          "missing_api_key",
        ),
      );
    return;
  }

  const key = await lookupKey(token);
  if (!key) {
    await reply
      .code(401)
      .send(errorBody("Invalid API key.", "invalid_request_error", "invalid_api_key"));
    return;
  }

  req.apiKey = key;
}
