"""ingest worker — consume llm.events and persist them.

P2 scope: every event is written three ways, all off the gateway's hot path.

  Cassandra  metrics_by_model / metrics_by_key  — one raw row per event, so the
             dashboard can drill into "recent calls for model/key X today".
  Cassandra  rollup_hourly                       — hourly counters (cost, requests,
             errors, tokens, latency sum + histogram, cache hits) per breakdown
             axis. These feed the trend charts, which never scan the raw tables.
  MongoDB    requests                            — the event's metrics merged into
             the request document, so the Requests screen has rows to list and a
             detail to open. The gateway writes the prompt/response bodies to the
             same document (keyed by event_id) the moment the call finishes, so we
             merge with $set rather than replacing: a ReplaceOne here would delete
             the bodies, and the two writers race by nature. Synthetic loadgen
             events have no bodies — those documents are metrics only.

Throughput & correctness:
  - Events are buffered and flushed in batches (by size or a time interval). The
    win is on the counters: many events collapse into a handful of counter
    UPDATEs per (dim, hour) bucket instead of one round-trip each.
  - Kafka offsets are committed manually, only *after* a flush succeeds. So a
    crash re-processes at most one buffer — at-least-once. Raw inserts and the
    Mongo upsert are keyed by event_id and idempotent under replay; the rollup
    counters are not, so a crash mid-flush can slightly over-count a bucket. That
    trade (cheap reads, rare small drift) is acceptable for dashboards.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import uuid
from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, timezone

from cassandra.cluster import Cluster, Session
from cassandra.query import PreparedStatement
from confluent_kafka import Consumer, KafkaError
from pymongo import MongoClient, UpdateOne

# --- Kafka ---
TOPIC = os.environ.get("KAFKA_TOPIC", "llm.events")
GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "ingest")
BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092")

# --- Cassandra ---
CASSANDRA_CONTACT_POINTS = os.environ.get("CASSANDRA_CONTACT_POINTS", "localhost").split(",")
CASSANDRA_PORT = int(os.environ.get("CASSANDRA_PORT", "9042"))
CASSANDRA_KEYSPACE = os.environ.get("CASSANDRA_KEYSPACE", "tollbooth")

# --- MongoDB ---
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.environ.get("MONGO_DB", "tollbooth")
# requests can grow without bound, so age them out with a TTL index (spec 7.3).
REQUESTS_TTL_DAYS = int(os.environ.get("REQUESTS_TTL_DAYS", "30"))

# --- Batching ---
# Flush when the buffer hits this many events, or this many seconds have passed
# since the last flush — whichever comes first. The time bound keeps low-traffic
# events from sitting in the buffer indefinitely.
BATCH_SIZE = int(os.environ.get("INGEST_BATCH_SIZE", "500"))
FLUSH_SECONDS = float(os.environ.get("INGEST_FLUSH_SECONDS", "5"))

# --- Latency histogram ---
# Upper bounds, in ms, of the rollup's latency buckets. These mirror the
# rollup_hourly lat_le_* counter columns one for one and in order — the ladder
# really lives in the column names, so re-cutting it is an ALTER TABLE, not just
# an edit here. Not configurable for the same reason.
#
# The bounds span a cache hit (~1ms) to a slow completion (10s+). Anything past
# the last bound is counted only by `requests`, which is the +Inf bucket: with
# Prometheus `le` semantics every bucket counts the requests at or below its
# bound, so the unbounded one is by definition just "all of them". See init.cql.
LATENCY_BUCKETS_MS = (10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)

_running = True


def bucket_index(latency_ms: int) -> int:
    """Which histogram bucket a latency falls in.

    bisect_left gives the first bound that is >= the latency, which is exactly
    `le` semantics: 10ms belongs to lat_le_10, 11ms to lat_le_25. Anything past
    the last bound returns len(LATENCY_BUCKETS_MS) — the overflow slot, which is
    never written out (see _empty_bucket).
    """
    return bisect_left(LATENCY_BUCKETS_MS, latency_ms)


def _stop(*_args) -> None:
    global _running
    _running = False


# --------------------------------------------------------------------------- #
# Connections
# --------------------------------------------------------------------------- #
def connect_cassandra() -> tuple[Cluster, Session]:
    """Connect to Cassandra, retrying while it (or the schema) comes up.

    Compose already waits for cassandra-init to finish before starting this
    worker, but we retry anyway so the worker is robust when run standalone.
    """
    last_err: Exception | None = None
    for attempt in range(30):
        try:
            cluster = Cluster(CASSANDRA_CONTACT_POINTS, port=CASSANDRA_PORT)
            session = cluster.connect(CASSANDRA_KEYSPACE)
            return cluster, session
        except Exception as exc:  # noqa: BLE001 — surface any driver/connection error and retry
            last_err = exc
            print(f"ingest: waiting for Cassandra ({attempt + 1}/30): {exc}", flush=True)
            time.sleep(2)
    raise RuntimeError(f"could not connect to Cassandra: {last_err}")


def connect_mongo():
    client = MongoClient(MONGO_URI)
    requests = client[MONGO_DB]["requests"]
    # TTL indexes act on a BSON date field, so we store `ts` as a real datetime
    # (see normalize()). Idempotent: create_index is a no-op if it already exists.
    requests.create_index("ts", expireAfterSeconds=REQUESTS_TTL_DAYS * 86400)
    return client, requests


def prepare(session: Session) -> dict[str, PreparedStatement]:
    # Generated from the ladder rather than spelled out, so the statement and
    # LATENCY_BUCKETS_MS cannot drift apart — a bucket added to one but not the
    # other would silently mis-bind every counter after it.
    hist_set = ", ".join(f"lat_le_{b} = lat_le_{b} + ?" for b in LATENCY_BUCKETS_MS)

    return {
        "by_model": session.prepare(
            "INSERT INTO metrics_by_model "
            "(project_id, model, day, ts, event_id, cost_usd, prompt_tokens, "
            " completion_tokens, latency_ms, status, cache_hit) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        "by_key": session.prepare(
            "INSERT INTO metrics_by_key "
            "(project_id, api_key_id, day, ts, event_id, cost_usd, total_tokens, "
            " latency_ms, status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        # Counter tables are updated, never inserted. The SET deltas bind first,
        # then the partition/row key in the WHERE clause.
        "rollup": session.prepare(
            "UPDATE rollup_hourly SET "
            "cost_micros = cost_micros + ?, requests = requests + ?, "
            "errors = errors + ?, prompt_tokens = prompt_tokens + ?, "
            "completion_tokens = completion_tokens + ?, "
            "latency_sum_ms = latency_sum_ms + ?, cache_hits = cache_hits + ?, "
            "lat_count = lat_count + ?, "
            f"{hist_set} "
            "WHERE project_id = ? AND dim = ? AND day = ? AND hour = ?"
        ),
        # Which models/keys were seen today. Rewriting the same row on every flush
        # is free in Cassandra (an insert *is* an upsert) and it is what makes the
        # rollup's dimensions discoverable — see dims_by_day in init.cql.
        "dim": session.prepare(
            "INSERT INTO dims_by_day (project_id, day, kind, value, provider) "
            "VALUES (?, ?, ?, ?, ?)"
        ),
    }


# --------------------------------------------------------------------------- #
# Event parsing
# --------------------------------------------------------------------------- #
def _parse_ts(raw: str | None) -> datetime:
    if raw:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def normalize(event: dict) -> dict:
    """Coerce a raw event into the exact types Cassandra/Mongo want, and derive
    the day/hour buckets (UTC) the rollup is keyed by."""
    ts = _parse_ts(event.get("ts"))

    try:
        event_id = uuid.UUID(str(event.get("event_id")))
    except (ValueError, TypeError):
        event_id = uuid.uuid4()

    prompt_tokens = int(event.get("prompt_tokens") or 0)
    completion_tokens = int(event.get("completion_tokens") or 0)
    cost_usd = float(event.get("cost_usd") or 0.0)
    latency_ms = int(event.get("latency_ms") or 0)
    status = event.get("status") or "unknown"

    return {
        "event_id": event_id,
        "event_id_str": str(event_id),
        "ts": ts,
        "day": ts.date(),
        "hour": ts.hour,
        "project_id": event.get("project_id") or "default",
        "api_key_id": event.get("api_key_id") or "unknown",
        "provider": event.get("provider"),
        "model": event.get("model") or "unknown",
        "endpoint": event.get("endpoint"),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "cost_usd": cost_usd,
        # Counters are integer-only; money rides as micro-dollars (see init.cql).
        "cost_micros": round(cost_usd * 1_000_000),
        "latency_ms": latency_ms,
        # Resolved once here rather than in the fold: the same event lands in
        # three rollup dims, and the bucket it belongs to is the same all three
        # times.
        "lat_bucket": bucket_index(latency_ms),
        "ttfb_ms": event.get("ttfb_ms"),
        "status": status,
        # "cached" counts as a hit, not an error; anything not success/cached is an error.
        "is_error": status not in ("success", "cached"),
        "cache_hit": bool(event.get("cache_hit")),
        "error_type": event.get("error_type"),
        "feature_tag": event.get("feature_tag"),
    }


def _mongo_doc(e: dict) -> dict:
    """The metrics half of a request document.

    No `_id`: on an upsert Mongo takes it from the filter, and naming the
    immutable field in $set is an error. The other half — the prompt and the
    response — is written by the gateway under the same key.
    """
    return {
        "ts": e["ts"],
        "project_id": e["project_id"],
        "api_key_id": e["api_key_id"],
        "provider": e["provider"],
        "model": e["model"],
        "endpoint": e["endpoint"],
        "prompt_tokens": e["prompt_tokens"],
        "completion_tokens": e["completion_tokens"],
        "total_tokens": e["total_tokens"],
        "cost_usd": e["cost_usd"],
        "latency_ms": e["latency_ms"],
        "ttfb_ms": e["ttfb_ms"],
        "status": e["status"],
        "cache_hit": e["cache_hit"],
        "error_type": e["error_type"],
        "feature_tag": e["feature_tag"],
    }


# --------------------------------------------------------------------------- #
# Flush
# --------------------------------------------------------------------------- #
def _empty_bucket() -> dict:
    return {
        "cost_micros": 0, "requests": 0, "errors": 0, "prompt_tokens": 0,
        "completion_tokens": 0, "latency_sum_ms": 0, "cache_hits": 0,
        # Latency histogram, counted *disjointly* while folding: one increment
        # per event, into the single bucket it belongs to. The columns want
        # cumulative `le` counts, but deriving those here would mean touching
        # every bucket at or above the event's — ten dict writes per event per
        # dim instead of one, on the hottest loop in the worker. _cumulative_hist
        # does it once per flush instead, which is the same answer for a fraction
        # of the work (see the note there).
        #
        # One slot longer than the ladder: the tail slot absorbs latencies past
        # the last bound, so the fold needs no bounds check. It is never written
        # out — its bucket is +Inf, which is `requests`.
        "hist": [0] * (len(LATENCY_BUCKETS_MS) + 1),
    }


def _cumulative_hist(hist: list[int]) -> list[int]:
    """Disjoint bucket counts -> the cumulative `le` deltas the columns take.

    Safe because a counter UPDATE *adds* a delta, and cumulative counts are
    additive: summing each flush's cumulative counts gives the same column value
    as if every event had incremented every bucket at or above it. So the running
    total can be built once per bucket here, at flush time, instead of once per
    event in the fold.

    Drops the overflow slot — see _empty_bucket.
    """
    out: list[int] = []
    running = 0
    for count in hist[: len(LATENCY_BUCKETS_MS)]:
        running += count
        out.append(running)
    return out


def flush(session, stmts, requests_coll, consumer, buffer: list[dict], reason: str) -> None:
    """Write the buffered events to Cassandra + Mongo, then commit Kafka offsets.

    Raises on any storage failure so offsets are *not* committed — the process
    exits, restarts, and reprocesses from the last commit (at-least-once).
    """
    if not buffer:
        return

    # 1. Raw rows: fire all inserts async, then wait for them together.
    futures = []
    rollup: dict[tuple, dict] = defaultdict(_empty_bucket)
    # (project, day, kind, value) -> provider. Collapsed across the whole buffer,
    # so a batch of 500 events costs a handful of writes, not 500.
    dims: dict[tuple, str | None] = {}
    mongo_ops = []
    for e in buffer:
        futures.append(session.execute_async(stmts["by_model"], (
            e["project_id"], e["model"], e["day"], e["ts"], e["event_id"],
            e["cost_usd"], e["prompt_tokens"], e["completion_tokens"],
            e["latency_ms"], e["status"], e["cache_hit"],
        )))
        futures.append(session.execute_async(stmts["by_key"], (
            e["project_id"], e["api_key_id"], e["day"], e["ts"], e["event_id"],
            e["cost_usd"], e["total_tokens"], e["latency_ms"], e["status"],
        )))

        # 2. Fold each event into its rollup buckets (one per breakdown axis).
        for dim in ("all", f"model:{e['model']}", f"key:{e['api_key_id']}"):
            b = rollup[(e["project_id"], dim, e["day"], e["hour"])]
            b["cost_micros"] += e["cost_micros"]
            b["requests"] += 1
            b["errors"] += 1 if e["is_error"] else 0
            b["prompt_tokens"] += e["prompt_tokens"]
            b["completion_tokens"] += e["completion_tokens"]
            b["latency_sum_ms"] += e["latency_ms"]
            b["cache_hits"] += 1 if e["cache_hit"] else 0
            b["hist"][e["lat_bucket"]] += 1

        # 3. And note that those axes exist, so the dashboard can find them again
        #    without scanning anything (see dims_by_day in init.cql).
        dims[(e["project_id"], e["day"], "model", e["model"])] = e["provider"]
        dims[(e["project_id"], e["day"], "key", e["api_key_id"])] = None

        # $set, not a replace: the gateway owns the prompt/response fields of this
        # same document and may have written them a moment ago (or be about to).
        mongo_ops.append(
            UpdateOne({"_id": e["event_id_str"]}, {"$set": _mongo_doc(e)}, upsert=True)
        )

    for f in futures:
        f.result()

    # 4. One counter UPDATE per bucket — this is where batching pays off.
    rollup_futures = [
        session.execute_async(stmts["rollup"], (
            b["cost_micros"], b["requests"], b["errors"], b["prompt_tokens"],
            b["completion_tokens"], b["latency_sum_ms"], b["cache_hits"],
            # sum(hist), not b["requests"] — the histogram's denominator has to be
            # derived from the histogram. They are the same number here, but only
            # here; see lat_count in init.cql.
            sum(b["hist"]), *_cumulative_hist(b["hist"]),
            project_id, dim, day, hour,
        ))
        for (project_id, dim, day, hour), b in rollup.items()
    ]
    dim_futures = [
        session.execute_async(stmts["dim"], (project_id, day, kind, value, provider))
        for (project_id, day, kind, value), provider in dims.items()
    ]
    for f in rollup_futures + dim_futures:
        f.result()

    # 5. Mongo request documents.
    if mongo_ops:
        requests_coll.bulk_write(mongo_ops, ordered=False)

    # 6. Only now is it safe to advance the committed offset.
    consumer.commit(asynchronous=False)

    print(
        f"ingest: flushed {len(buffer)} events -> "
        f"{len(rollup)} rollup buckets ({reason})",
        flush=True,
    )
    buffer.clear()


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def build_consumer() -> Consumer:
    return Consumer({
        "bootstrap.servers": BOOTSTRAP,
        "group.id": GROUP_ID,
        # First run of a fresh group reads the backlog; restarts resume, not replay.
        "auto.offset.reset": "earliest",
        # We commit by hand after each successful flush (see flush()).
        "enable.auto.commit": False,
    })


def main() -> None:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    cluster, session = connect_cassandra()
    stmts = prepare(session)
    mongo_client, requests_coll = connect_mongo()
    consumer = build_consumer()
    consumer.subscribe([TOPIC])
    print(
        f"ingest: consuming '{TOPIC}' from {BOOTSTRAP} as group '{GROUP_ID}' -> "
        f"Cassandra {CASSANDRA_CONTACT_POINTS}/{CASSANDRA_KEYSPACE}, Mongo {MONGO_DB}",
        flush=True,
    )

    buffer: list[dict] = []
    seen = 0
    last_flush = time.monotonic()
    try:
        while _running:
            msg = consumer.poll(1.0)
            if msg is not None:
                if msg.error():
                    # End of partition is normal; anything else is worth surfacing.
                    if msg.error().code() != KafkaError._PARTITION_EOF:
                        print(f"ingest: consumer error: {msg.error()}", file=sys.stderr, flush=True)
                else:
                    try:
                        buffer.append(normalize(json.loads(msg.value())))
                        seen += 1
                    except (ValueError, TypeError) as exc:
                        print(f"ingest: skipping bad message: {exc}", file=sys.stderr, flush=True)

            due = (time.monotonic() - last_flush) >= FLUSH_SECONDS
            if buffer and (len(buffer) >= BATCH_SIZE or due):
                flush(session, stmts, requests_coll, consumer, buffer, "batch")
                last_flush = time.monotonic()
    finally:
        # Drain whatever's buffered so a clean shutdown doesn't strand events.
        try:
            flush(session, stmts, requests_coll, consumer, buffer, "shutdown")
        finally:
            consumer.close()
            cluster.shutdown()
            mongo_client.close()
            print(f"ingest: shutting down after {seen} events", flush=True)


if __name__ == "__main__":
    main()
