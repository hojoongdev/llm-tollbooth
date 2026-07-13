import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { INTERNAL_TOKEN } from "../config.js";
import { errorBody } from "../errors.js";
import { invalidateKeyCache } from "../keys.js";

/**
 * /internal — what the rest of the stack calls, as opposed to what customers call.
 *
 * There is exactly one route, and it exists because of a number we measured: the
 * gateway caches key state for 30 seconds (keys.ts), and a key blocked in Mongo went
 * on being served for 31 more seconds. That cache is not negotiable — it is what
 * keeps a Mongo round-trip off every single call — so the fix is not to shorten it
 * but to let the writers say when it is wrong.
 *
 * For a *budget* block the staleness barely matters: the gateway keeps its own spend
 * tally and refuses an over-budget key in real time, so the flag is belt and braces.
 * It matters for the rules that the gateway cannot see coming — a key blocked because
 * it is melting down, or leaking something — where being advisory for half a minute
 * is the whole ballgame.
 *
 * Callers: the rules worker's `block` action, and the console's own Block button,
 * which had precisely the same lag and now doesn't.
 */
export function registerAdmin(app: FastifyInstance): void {
  if (!INTERNAL_TOKEN) {
    app.log.warn(
      "GATEWAY_INTERNAL_TOKEN is unset — /internal is disabled, so a key blocked from " +
        "the console or by a rule will keep working here for up to 30s (the key cache TTL)",
    );
    return;
  }

  // Compare digests, not the tokens: timingSafeEqual throws on a length mismatch,
  // which would itself leak the length it was called to protect. Two SHA-256s are
  // always 32 bytes.
  const expected = createHash("sha256").update(INTERNAL_TOKEN).digest();
  const authorized = (given: unknown): boolean =>
    typeof given === "string" &&
    timingSafeEqual(createHash("sha256").update(given).digest(), expected);

  app.post("/internal/keys/invalidate", async (req, reply) => {
    if (!authorized(req.headers["x-internal-token"])) {
      return reply
        .code(401)
        .send(errorBody("Bad internal token.", "invalid_request_error", "invalid_internal_token"));
    }

    // The whole map, not one entry — and that is forced, not lazy. The cache is keyed
    // by the key's *hash*, and a caller that knows a key id cannot produce one: the
    // raw key is never stored, so the hash is not derivable from anything they hold.
    // The price is one Mongo lookup per live key on its next call, which is a fine
    // trade for a block that actually blocks.
    invalidateKeyCache();
    req.log.info("key cache invalidated");
    return reply.code(204).send();
  });
}
