import type { FastifyInstance } from "fastify";

import { droppedEvents, kafkaReady } from "../kafka.js";
import { mongoReady } from "../mongo.js";

/**
 * Health (spec §14 — every service has one).
 *
 * Note it stays 200 with Kafka down, reporting `degraded` instead. That is the
 * honest answer: the gateway can still serve LLM calls without the pipeline, it
 * just can't record them. Failing the check would make compose restart-loop a
 * service that is, from the caller's point of view, working fine.
 */
export function registerHealth(app: FastifyInstance): void {
  app.get("/health", async () => ({
    status: kafkaReady() && mongoReady() ? "ok" : "degraded",
    service: "gateway",
    kafka: kafkaReady() ? "connected" : "disconnected",
    mongo: mongoReady() ? "connected" : "disconnected",
    dropped_events: droppedEvents(),
  }));
}
