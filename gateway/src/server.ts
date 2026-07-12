import Fastify from "fastify";

import { HOST, LOG_LEVEL, PORT } from "./config.js";
import { connectKafka, disconnectKafka } from "./kafka.js";
import { initKeys } from "./keys.js";
import { closeMongo, connectMongo } from "./mongo.js";
import { initPricing } from "./pricing.js";
import { registerChat } from "./routes/chat.js";
import { registerHealth } from "./routes/health.js";
import { registerModels } from "./routes/models.js";

const app = Fastify({
  logger: { level: LOG_LEVEL },
  // Prompts *are* the payload here — a long conversation with documents pasted
  // into it blows straight past Fastify's 1MB default.
  bodyLimit: 8 * 1024 * 1024,
});

async function main(): Promise<void> {
  // Mongo is a hard dependency: without it we cannot authenticate anyone, so
  // there is nothing to serve and failing to boot is the correct answer. Kafka
  // is not — connectKafka resolves either way and retries in the background,
  // because a gateway that can still answer calls should still answer them.
  await connectMongo();
  await initKeys(app.log);
  await initPricing(app.log);
  await connectKafka(app.log);

  registerHealth(app);
  registerModels(app);
  registerChat(app);

  await app.listen({ port: PORT, host: HOST });
}

// Compose stops a container with SIGTERM. Close the server first so calls in
// flight get to finish, and only then drop the connections underneath them.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info(`${signal} received — shutting down`);
      await app.close();
      await disconnectKafka();
      await closeMongo();
      process.exit(0);
    })();
  });
}

main().catch((err) => {
  app.log.error({ err }, "gateway failed to start");
  process.exit(1);
});
