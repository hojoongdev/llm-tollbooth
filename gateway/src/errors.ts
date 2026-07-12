/**
 * Errors go back in OpenAI's shape, because our callers are OpenAI clients —
 * they only had to change a base URL to point at us, so a tollbooth rejection
 * has to surface through their SDK the same way a provider rejection would.
 */
export function errorBody(message: string, type: string, code: string) {
  return { error: { message, type, code, param: null } };
}

/** A failure we can attribute — `type` becomes `error_type` on the event. */
export class GatewayError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
