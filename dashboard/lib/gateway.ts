import "server-only";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "";
const INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? "";

/**
 * Tell the gateway that a key it may be holding is no longer what it thinks.
 *
 * The console writes key state to Mongo; the gateway caches key state for 30 seconds,
 * because a Mongo round-trip on every call is exactly what that cache exists to avoid.
 * The consequence was that Block took effect up to 31 seconds after the button said it
 * had — measured, not assumed.
 *
 * Never throws, and that is the point. The block is already saved: it is in Mongo, and
 * the gateway will honour it within 30 seconds whatever happens here. A console that
 * reported the block as *failed* because it could not reach the gateway would be lying
 * about the one thing that actually went right.
 */
export async function invalidateGatewayKeys(): Promise<void> {
  if (!GATEWAY_URL || !INTERNAL_TOKEN) return;

  try {
    await fetch(`${GATEWAY_URL.replace(/\/+$/, "")}/internal/keys/invalidate`, {
      method: "POST",
      // An empty `{}` rather than no body: Fastify answers 415 to a POST that carries
      // a Content-Length without a Content-Type. The route takes no arguments — it
      // just forgets everything it knows.
      headers: { "x-internal-token": INTERNAL_TOKEN, "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    console.warn("gateway key-cache invalidation failed; the change lands within 30s anyway", err);
  }
}
