"""loadgen CLI — publish synthetic LLM events to Kafka at a target rate.

This is "mode 1" from the spec: events go straight to the topic, so we can
measure the pipeline's throughput independently of the gateway.

Example:
    python -m loadgen --rps 50 --duration 10 --error-rate 0.05
"""

from __future__ import annotations

import argparse
import json
import os
import time

from confluent_kafka import Producer

from .events import make_event


def build_producer(bootstrap: str) -> Producer:
    return Producer(
        {
            "bootstrap.servers": bootstrap,
            "client.id": "loadgen",
            # Favour throughput: batch a little before sending.
            "linger.ms": 20,
        }
    )


def run(args: argparse.Namespace) -> None:
    producer = build_producer(args.bootstrap)

    interval = 1.0 / args.rps if args.rps > 0 else 0.0
    total = 0
    errors_seen = 0
    started = time.monotonic()
    deadline = started + args.duration

    print(
        f"loadgen: publishing to '{args.topic}' on {args.bootstrap} "
        f"at ~{args.rps} rps for {args.duration}s"
    )

    while time.monotonic() < deadline:
        event = make_event(
            project_id=args.project,
            error_rate=args.error_rate,
        )
        if event["status"] == "error":
            errors_seen += 1

        producer.produce(
            topic=args.topic,
            key=event["project_id"],
            value=json.dumps(event).encode("utf-8"),
        )
        # Serve delivery callbacks and keep the internal queue from filling up.
        producer.poll(0)

        total += 1
        if interval:
            time.sleep(interval)

    producer.flush(10)
    elapsed = time.monotonic() - started
    rate = total / elapsed if elapsed else 0
    print(
        f"loadgen: done — {total} events in {elapsed:.1f}s "
        f"({rate:.0f}/s effective, {errors_seen} errors)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="loadgen", description=__doc__)
    parser.add_argument(
        "--bootstrap",
        default=os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092"),
        help="Kafka bootstrap servers (default: env KAFKA_BOOTSTRAP or localhost:9092)",
    )
    parser.add_argument("--topic", default="llm.events")
    parser.add_argument("--project", default="default", help="project_id to stamp on events")
    parser.add_argument("--rps", type=float, default=20.0, help="events per second")
    parser.add_argument("--duration", type=float, default=10.0, help="seconds to run")
    parser.add_argument(
        "--error-rate",
        type=float,
        default=0.05,
        help="fraction of events marked as errors (0..1)",
    )
    run(parser.parse_args())


if __name__ == "__main__":
    main()
