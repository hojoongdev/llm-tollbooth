import type { FastifyInstance } from "fastify";

import { authenticate } from "../auth.js";
import { knownModels } from "../pricing.js";

/**
 * GET /v1/models — the other half of OpenAI compatibility. SDKs and tools call
 * it to discover what they can ask for, so "just change the base URL" holds.
 *
 * What we can serve is what we can price, so the pricing table is the catalogue.
 */
export function registerModels(app: FastifyInstance): void {
  app.get("/v1/models", { preHandler: authenticate }, async () => {
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
