import { GatewayError } from "./errors.js";

/**
 * Model fallback policy (spec §4 B), kept pure and apart from the routing so the
 * two decisions it makes can be tested without standing up a provider.
 */

/**
 * The model to try when `primary` fails, or null if there is none.
 *
 * A per-key setting wins over the global default (a key can name its own backup),
 * and a fallback that equals the primary is no fallback at all — retrying the same
 * model against the same failure just fails twice.
 */
export function fallbackModelFor(
  primary: string,
  keyFallback: string | null | undefined,
  globalFallback: string,
): string | null {
  const fb = (keyFallback ?? "").trim() || globalFallback;
  return fb && fb !== primary ? fb : null;
}

/**
 * Whether a failed call is worth retrying on the backup model.
 *
 * A malformed request is the caller's bug and a different model will not fix it, so
 * that one is not retried. Every other upstream failure — timeout, unreachable,
 * 5xx, a rate limit, a model the provider doesn't have, bad credentials — is
 * exactly the kind of thing a backup exists for, including the ones that are
 * really "this provider, right now" rather than "this request".
 */
export function isFallbackWorthy(err: unknown): boolean {
  if (err instanceof GatewayError) return err.type !== "upstream_invalid_request";
  return true;
}
