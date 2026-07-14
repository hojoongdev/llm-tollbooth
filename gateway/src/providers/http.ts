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

/**
 * Open a streaming upstream call and hand back the live response for the caller to
 * read frame by frame.
 *
 * The timeout is deliberately different from the non-streaming one: it bounds the
 * time to *headers*, not the whole call. A completion that streams for two minutes
 * is a working call, not a stuck one — so once the headers land the timer is
 * cleared and the body is free to take as long as it takes. What we refuse to wait
 * forever for is an upstream that accepts the socket and then never answers.
 */
export async function openUpstreamStream(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GatewayError(
      timedOut ? "upstream_timeout" : "upstream_unreachable",
      timedOut
        ? `Upstream did not respond within ${PROVIDER_TIMEOUT_MS} ms.`
        : `Could not reach upstream: ${err instanceof Error ? err.message : String(err)}`,
      504,
    );
  }
  // Headers are in — from here the stream sets its own pace.
  clearTimeout(timer);

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new GatewayError(errorTypeFor(res.status), `Upstream ${res.status}: ${detail}`, upstreamStatus(res.status));
  }
  if (!res.body) {
    throw new GatewayError("upstream_error", "Upstream accepted the call but returned no stream body.", 502);
  }
  return res;
}

/**
 * Parse a Server-Sent Events body into `{ event, data }` records.
 *
 * SSE frames are separated by a blank line and each carries `field: value` lines;
 * we care about `event:` (Anthropic names its frames, OpenAI doesn't) and `data:`
 * (which may span several lines and is re-joined with newlines). Comment lines
 * (`:` — keep-alive pings) and unknown fields are dropped. Handles CRLF, and
 * flushes a trailing frame that the upstream didn't terminate with a blank line.
 */
export async function* sseEvents(
  res: Response,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = parseSseFrame(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (frame) yield frame;
      }
    }
    const tail = parseSseFrame(buf.replace(/\r\n/g, "\n"));
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** One SSE frame (the text between blank lines) -> its event name and data, or
 *  null if it carried no data line. Pure, so the parsing is unit-testable. */
export function parseSseFrame(frame: string): { event: string | null; data: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue; // blank or comment (keep-alive)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // SSE strips one leading space
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}
