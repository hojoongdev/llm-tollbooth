import { Client, types } from "cassandra-driver";
import type { FastifyBaseLogger } from "fastify";

import {
  CASSANDRA_CONTACT_POINTS,
  CASSANDRA_DC,
  CASSANDRA_KEYSPACE,
  PROJECT_ID,
} from "./config.js";

/**
 * The gateway reads Cassandra for exactly one thing: how much a key has already
 * spent (see budget.ts). It never writes — the ingest worker owns that side.
 *
 * The rollup is the right source precisely because it is the number the console
 * shows. A budget enforced against a different tally than the one its owner is
 * looking at would be a budget nobody could reason about.
 */
let client: Client | null = null;
let ready = false;
let log: FastifyBaseLogger;

export const cassandraReady = (): boolean => ready;

export async function connectCassandra(logger: FastifyBaseLogger): Promise<void> {
  log = logger;
  client = new Client({
    contactPoints: CASSANDRA_CONTACT_POINTS.split(","),
    // The driver refuses to start without this, and a single-node cassandra:5.0
    // calls its datacenter "datacenter1" (nodetool status).
    localDataCenter: CASSANDRA_DC,
    keyspace: CASSANDRA_KEYSPACE,
  });

  try {
    await client.connect();
    ready = true;
    log.info({ keyspace: CASSANDRA_KEYSPACE }, "cassandra connected — budgets reconcile against the rollups");
  } catch (err) {
    // Same call as Kafka: keep serving. A gateway that stops answering because
    // its bookkeeping store is down has turned a reporting outage into an
    // application outage. Budgets fall back to this process's own tally, which
    // is documented as failing open — and /health says so.
    ready = false;
    log.error({ err }, "cassandra unavailable — budgets fall back to this process's tally only");
    setTimeout(() => void connectCassandra(logger), 10_000).unref();
  }
}

/** Counters come back as Long. */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const maybe = v as { toNumber?: () => number };
  return typeof maybe.toNumber === "function" ? maybe.toNumber() : Number(v);
}

/**
 * What this key has spent on each of `days`, in micro-dollars.
 *
 * One query, however many days: the rollup's partition key is
 * (project_id, dim, day), so a month is a handful of partitions read by name —
 * never a scan.
 */
export async function spendMicrosByDay(keyId: string, days: string[]): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  if (!client || !ready || days.length === 0) return byDay;

  const placeholders = days.map(() => "?").join(",");
  const cql =
    "SELECT day, cost_micros FROM rollup_hourly " +
    `WHERE project_id = ? AND dim = ? AND day IN (${placeholders})`;
  const params = [PROJECT_ID, `key:${keyId}`, ...days.map((d) => types.LocalDate.fromString(d))];

  const res = await client.execute(cql, params, { prepare: true });
  for (const row of res.rows) {
    const day = String(row.day);
    byDay.set(day, (byDay.get(day) ?? 0) + num(row.cost_micros));
  }
  return byDay;
}

export async function closeCassandra(): Promise<void> {
  ready = false;
  await client?.shutdown();
  client = null;
}
