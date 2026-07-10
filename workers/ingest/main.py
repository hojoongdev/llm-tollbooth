"""ingest worker — consume llm.events and log each one.

P1 scope: prove the pipeline end to end (loadgen -> Kafka -> worker). Persisting
to Cassandra/MongoDB comes in P2; here we just subscribe and print.
"""

from __future__ import annotations

import json
import os
import signal
import sys

from confluent_kafka import Consumer, KafkaError

TOPIC = os.environ.get("KAFKA_TOPIC", "llm.events")
GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "ingest")
BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092")

_running = True


def _stop(*_args) -> None:
    global _running
    _running = False


def build_consumer() -> Consumer:
    return Consumer(
        {
            "bootstrap.servers": BOOTSTRAP,
            "group.id": GROUP_ID,
            # Start from the beginning the first time this group runs, so a fresh
            # demo sees events already sitting in the topic.
            "auto.offset.reset": "earliest",
            # Commit read positions periodically; on restart we resume, not replay.
            "enable.auto.commit": True,
        }
    )


def handle(event: dict) -> None:
    """P1: just log. P2 will fan this out to Cassandra + MongoDB writers."""
    status = event.get("status")
    marker = "ok " if status == "success" else "ERR"
    print(
        f"[{marker}] {event.get('provider')}/{event.get('model')} "
        f"tokens={event.get('prompt_tokens')}+{event.get('completion_tokens')} "
        f"cost=${event.get('cost_usd')} latency={event.get('latency_ms')}ms "
        f"project={event.get('project_id')} tag={event.get('feature_tag')}",
        flush=True,
    )


def main() -> None:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    consumer = build_consumer()
    consumer.subscribe([TOPIC])
    print(
        f"ingest: consuming '{TOPIC}' from {BOOTSTRAP} as group '{GROUP_ID}'",
        flush=True,
    )

    seen = 0
    try:
        while _running:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                # End of partition is normal; anything else is worth surfacing.
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print(f"ingest: consumer error: {msg.error()}", file=sys.stderr, flush=True)
                continue

            try:
                event = json.loads(msg.value())
            except (ValueError, TypeError) as exc:
                print(f"ingest: skipping bad message: {exc}", file=sys.stderr, flush=True)
                continue

            handle(event)
            seen += 1
    finally:
        consumer.close()
        print(f"ingest: shutting down after {seen} events", flush=True)


if __name__ == "__main__":
    main()
