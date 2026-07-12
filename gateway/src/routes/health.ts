import type { FastifyInstance } from "fastify";

import { cassandraReady } from "../cassandra.js";
import { droppedEvents, kafkaReady } from "../kafka.js";
import { mongoReady } from "../mongo.js";

/**
 * Health (spec §14 — every service has one).
 *
 * It stays 200 with Kafka or Cassandra down, reporting `degraded` instead. That
 * is the honest answer: the gateway can still serve LLM calls without either —
 * it just can't record them, or reconcile budgets against what it recorded.
 * Failing the check would make compose restart-loop a service that is, from the
 * caller's point of view, working.
 */
export function registerHealth(app: FastifyInstance): void {
  app.get("/health", async () => {
    const ok = mongoReady() && kafkaReady() && cassandraReady();
    return {
      status: ok ? "ok" : "degraded",
      service: "gateway",
      mongo: mongoReady() ? "connected" : "disconnected",
      kafka: kafkaReady() ? "connected" : "disconnected",
      cassandra: cassandraReady() ? "connected" : "disconnected",
      dropped_events: droppedEvents(),
    };
  });
}
