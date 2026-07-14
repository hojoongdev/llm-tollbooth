import { describe, expect, it } from "vitest";

import { GatewayError } from "./errors.js";
import { fallbackModelFor, isFallbackWorthy } from "./fallback.js";

describe("fallbackModelFor", () => {
  it("prefers the key's own fallback over the global default", () => {
    expect(fallbackModelFor("gpt-4o", "gpt-4o-mini", "claude-haiku")).toBe("gpt-4o-mini");
  });

  it("uses the global default when the key sets none", () => {
    expect(fallbackModelFor("gpt-4o", null, "gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(fallbackModelFor("gpt-4o", "   ", "gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("is null when there is no fallback configured anywhere", () => {
    expect(fallbackModelFor("gpt-4o", null, "")).toBeNull();
  });

  it("is null when the only fallback is the primary itself (no point retrying it)", () => {
    expect(fallbackModelFor("gpt-4o", "gpt-4o", "")).toBeNull();
    expect(fallbackModelFor("gpt-4o", null, "gpt-4o")).toBeNull();
  });
});

describe("isFallbackWorthy", () => {
  it("retries on any upstream failure that a different model might survive", () => {
    for (const type of [
      "upstream_timeout",
      "upstream_unreachable",
      "upstream_error",
      "upstream_rate_limited",
      "upstream_model_not_found",
      "upstream_auth",
      "provider_error",
    ]) {
      expect(isFallbackWorthy(new GatewayError(type, "x"))).toBe(true);
    }
  });

  it("does not retry a request the caller malformed — a backup won't fix it", () => {
    expect(isFallbackWorthy(new GatewayError("upstream_invalid_request", "x"))).toBe(false);
  });

  it("retries an unknown (non-GatewayError) failure", () => {
    expect(isFallbackWorthy(new Error("boom"))).toBe(true);
  });
});
