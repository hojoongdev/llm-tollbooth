/**
 * Rough token count — the usual ~4-characters-per-token approximation.
 *
 * Only the mock provider needs this. Real providers report exact usage in their
 * response and *that* is what we meter; the mock has no tokenizer, so it counts
 * the text it actually produced this way. Good enough for cost and throughput
 * demos, and it keeps a multi-megabyte tokenizer out of the hot path.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
