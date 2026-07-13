import type { FastifyInstance } from "fastify";

import { authenticate } from "../auth.js";
import { errorBody } from "../errors.js";
import { knownModels } from "../pricing.js";

/**
 * GET /v1/models — the other half of OpenAI compatibility. SDKs and tools call
 * it to discover what they can ask for, so "just change the base URL" holds.
 *
 * What we can serve is what we can price, so the pricing table is the catalogue.
 */
export function registerModels(app: FastifyInstance): void {
  app.get("/v1/models", { preHandler: authenticate }, async (req, reply) => {
    // A blocked key cannot call anything, so it has no business browsing the
    // catalogue either. chat.ts has always refused it; this was the one other
    // authenticated surface, and it was answering.
    if (req.apiKey?.status === "blocked") {
      return reply
        .code(403)
        .send(errorBody("This API key is blocked.", "invalid_request_error", "key_blocked"));
    }

    const models = await knownModels();
    return {
      object: "list",
      data: models.map((m) => ({
        id: m._id,
        object: "model",
        created: Math.floor((m.updated_at?.getTime() ?? Date.now()) / 1000),
        owned_by: m.provider,
      })),
    };
  });
}
