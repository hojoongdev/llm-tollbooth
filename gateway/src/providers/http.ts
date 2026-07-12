import { PROVIDER_TIMEOUT_MS } from "../config.js";
import { GatewayError } from "../errors.js";

/**
 * The one HTTP call an adapter makes, with the parts that must not be got wrong
 * in one place: the timeout, the TTFB measurement, and the mapping from an
 * upstream failure to something the console can group by.
 */
export interface UpstreamCall<T> {
  body: T;
  /** Time until the response headers came back — genuinely the first byte. */
  ttfbMs: number;
}

export async function callUpstream<T>(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<UpstreamCall<T>> {
  const startedAt = performance.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      // A provider that has stopped answering must not hold our socket — and our
      // caller's — open indefinitely.
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GatewayError(
      timedOut ? "upstream_timeout" : "upstream_unreachable",
      timedOut
        ? `Upstream did not respond within ${PROVIDER_TIMEOUT_MS} ms.`
        : `Could not reach upstream: ${err instanceof Error ? err.message : String(err)}`,
      504,
    );
  }

  // fetch() resolves as soon as the headers land, so this is the real TTFB —
  // reading the body below is the rest of the call.
  const ttfbMs = Math.round(performance.now() - startedAt);

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new GatewayError(errorTypeFor(res.status), `Upstream ${res.status}: ${detail}`, upstreamStatus(res.status));
  }

  return { body: (await res.json()) as T, ttfbMs };
}

/** Becomes `error_type` on the event, so the console can group failures by cause. */
function errorTypeFor(status: number): string {
  if (status === 401 || status === 403) return "upstream_auth";
  if (status === 404) return "upstream_model_not_found";
  if (status === 429) return "upstream_rate_limited";
  if (status >= 500) return "upstream_error";
  return "upstream_invalid_request";
}

/**
 * What the *caller* sees. An upstream 429 stays a 429 so their client backs off
 * the way it already knows how; a bad request from us is our fault, so it does
 * not masquerade as theirs.
 */
function upstreamStatus(status: number): number {
  if (status === 429) return 429;
  if (status === 400) return 400;
  return 502;
}
