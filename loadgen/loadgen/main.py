"""loadgen CLI — synthetic traffic, in the two shapes the spec asks for (§11).

    mode 1 (events, default)   publish events straight to Kafka
    mode 2 (gateway)           make real HTTP calls to the gateway

The two measure different things and that is the whole point of having both.
Mode 1 loads the *pipeline* — how many events a second can Kafka, the worker,
Cassandra and Mongo actually absorb — with no gateway in the way to slow it down
or take the blame. Mode 2 loads the *gateway* — auth, budgets, rate limits,
cache, provider, event publish — and measures what a caller actually waits for.

Examples:
    python -m loadgen --rps 50 --duration 10 --error-rate 0.05
    python -m loadgen --mode gateway --api-key tb_… --rps 50 --duration 10
    python -m loadgen --mode gateway --api-key tb_… --distinct 5   # make cache hits
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


def run_events(args: argparse.Namespace) -> None:
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
        "--mode",
        choices=["events", "gateway"],
        default="events",
        help="events: publish straight to Kafka (loads the pipeline). "
        "gateway: real HTTP calls (loads the gateway).",
    )
    parser.add_argument("--rps", type=float, default=20.0, help="requests per second")
    parser.add_argument("--duration", type=float, default=10.0, help="seconds to run")

    events = parser.add_argument_group("mode 1: events")
    events.add_argument(
        "--bootstrap",
        default=os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092"),
        help="Kafka bootstrap servers (default: env KAFKA_BOOTSTRAP or localhost:9092)",
    )
    events.add_argument("--topic", default="llm.events")
    events.add_argument("--project", default="default", help="project_id to stamp on events")
    events.add_argument(
        "--error-rate",
        type=float,
        default=0.05,
        help="fraction of events marked as errors (0..1)",
    )

    gw = parser.add_argument_group("mode 2: gateway")
    gw.add_argument(
        "--url",
        default=os.environ.get("GATEWAY_URL", "http://localhost:8080"),
        help="gateway base URL (default: env GATEWAY_URL or localhost:8080)",
    )
    gw.add_argument(
        "--api-key",
        default=os.environ.get("GATEWAY_API_KEY", ""),
        help="gateway API key (default: env GATEWAY_API_KEY). The gateway prints one at boot.",
    )
    gw.add_argument(
        "--distinct",
        type=int,
        default=0,
        help="draw prompts from a pool of N distinct ones (0 = every prompt unique). "
        "Small values are how you make the response cache hit.",
    )
    gw.add_argument(
        "--concurrency",
        type=int,
        default=64,
        help="calls allowed in flight at once — must exceed rps x latency or the "
        "generator, not the gateway, becomes the bottleneck",
    )
    gw.add_argument("--timeout", type=float, default=30.0, help="per-call timeout (s)")

    args = parser.parse_args()

    if args.mode == "gateway":
        # Imported here so mode 1 doesn't need httpx installed to run.
        from .gateway import run as run_gateway

        run_gateway(args)
    else:
        run_events(args)


if __name__ == "__main__":
    main()
