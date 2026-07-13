import type { FastifyBaseLogger } from "fastify";
import { Kafka, Partitioners, logLevel, type Producer } from "kafkajs";

import { KAFKA_BOOTSTRAP, KAFKA_TOPIC } from "./config.js";
import type { LlmEvent } from "./event.js";

let producer: Producer | null = null;
let ready = false;
let log: FastifyBaseLogger;
let dropped = 0;

export const kafkaReady = (): boolean => ready;
export const droppedEvents = (): number => dropped;

/**
 * Connect the producer — and never let that failure reach the caller.
 *
 * Recording is best-effort by design, so a gateway that refuses to boot without
 * Kafka would contradict the whole point: it can still serve LLM calls with the
 * pipeline down, it just can't tell anyone about them. We retry in the
 * background and keep serving in the meantime.
 */
export async function connectKafka(logger: FastifyBaseLogger): Promise<void> {
  log = logger;
  const kafka = new Kafka({
    clientId: "gateway",
    brokers: KAFKA_BOOTSTRAP.split(","),
    logLevel: logLevel.ERROR,
  });

  producer = kafka.producer({
    // murmur2 keying, the same partitioner the Python producers use — so a given
    // project_id lands on the same partition whoever published it.
    createPartitioner: Partitioners.DefaultPartitioner,
    // llm.events is created explicitly (6 partitions) by kafka-init. Never let a
    // typo'd topic name auto-create a 1-partition one behind our back.
    allowAutoTopicCreation: false,
  });

  await attemptConnect();
}

async function attemptConnect(): Promise<void> {
  try {
    await producer!.connect();
    ready = true;
    log.info({ brokers: KAFKA_BOOTSTRAP, topic: KAFKA_TOPIC }, "kafka producer connected");
  } catch (err) {
    ready = false;
    log.error({ err }, "kafka unavailable — still serving calls, but events are being dropped");
    setTimeout(attemptConnect, 5_000).unref();
  }
}

/**
 * Publish one event, fire-and-forget (spec §14).
 *
 * We deliberately do not await the broker: a lost event costs a row in the
 * dashboard, whereas a blocked send would cost the user their answer. The
 * promise's rejection is swallowed into a counter and a log line.
 */
export function publishEvent(event: LlmEvent): void {
  if (!producer || !ready) {
    dropped++;
    return;
  }

  producer
    .send({
      topic: KAFKA_TOPIC,
      // key = project_id: keeps a project's events ordered within one partition.
      messages: [{ key: event.project_id, value: JSON.stringify(event) }],
    })
    .catch((err) => {
      dropped++;
      log.warn({ err, event_id: event.event_id }, "dropped event");
    });
}

export async function disconnectKafka(): Promise<void> {
  ready = false;
  await producer?.disconnect();
  producer = null;
}
