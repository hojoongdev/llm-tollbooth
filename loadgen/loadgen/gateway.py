"""Mode 2 — drive real traffic through the gateway (spec §11).

Mode 1 publishes events straight to Kafka, which measures the *pipeline*. This
mode makes actual HTTP calls to the gateway, which measures the thing the user
actually waits for: authentication, budget and rate-limit checks, the cache
lookup, the provider call, and the event publish, all on the request path.

It is what produces the two numbers the README quotes:
  - the gateway's own overhead   — run with MOCK_LATENCY_MS=0, so the only thing
                                   left in the latency is our own work
  - cache hit vs miss            — run with --distinct small, so prompts repeat
"""

from __future__ import annotations

import asyncio
import random
import statistics
import time
from collections import Counter
from dataclasses import dataclass, field

import httpx

from .events import pick_model


@dataclass
class Result:
    latencies_ms: list[float] = field(default_factory=list)
    statuses: Counter = field(default_factory=Counter)
    cache: Counter = field(default_factory=Counter)
    started: float = 0.0
    elapsed: float = 0.0


def _prompt(distinct: int, index: int) -> str:
    """A prompt per call, or one drawn from a fixed pool.

    `--distinct N` is how cache hits are produced: N distinct questions asked
    over and over is exactly the workload a response cache exists for. With
    distinct=0 every call is unique and every call is a miss.
    """
    if distinct > 0:
        return f"Explain concept #{index % distinct} in a couple of sentences."
    return f"Explain concept #{index} ({random.random():.6f}) in a couple of sentences."


async def _one(client: httpx.AsyncClient, url: str, headers: dict, index: int, distinct: int, result: Result) -> None:
    provider, model, _in_price, _out_price = pick_model()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": _prompt(distinct, index)}],
    }

    started = time.perf_counter()
    try:
        res = await client.post(f"{url}/v1/chat/completions", json=payload, headers=headers)
        elapsed_ms = (time.perf_counter() - started) * 1000
        result.latencies_ms.append(elapsed_ms)
        result.statuses[res.status_code] += 1
        # The gateway tells us whether we paid for this answer (see chat.ts).
        result.cache[res.headers.get("x-tollbooth-cache", "-")] += 1
    except Exception as exc:  # noqa: BLE001 — a transport failure is a result too
        result.statuses[type(exc).__name__] += 1


async def _run(args) -> Result:
    result = Result()
    headers = {"Authorization": f"Bearer {args.api_key}", "X-Tollbooth-Tag": "loadgen"}

    interval = 1.0 / args.rps if args.rps > 0 else 0.0
    deadline = time.perf_counter() + args.duration

    # One client, so connections are pooled — otherwise we'd be measuring TCP and
    # TLS setup rather than the gateway. The connection cap is what actually
    # bounds concurrency: at 250 ms a call, 50 rps needs ~13 calls in flight.
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)
    async with httpx.AsyncClient(limits=limits, timeout=args.timeout) as client:
        result.started = time.perf_counter()
        tasks: list[asyncio.Task] = []
        index = 0

        # Open-loop: fire on a schedule regardless of whether earlier calls have
        # come back. A closed loop (wait, then send) would silently throttle
        # itself to whatever the gateway can do and report a latency that never
        # includes queueing — which is the one thing a load test is for.
        while time.perf_counter() < deadline:
            tasks.append(asyncio.create_task(_one(client, args.url, headers, index, args.distinct, result)))
            index += 1
            if interval:
                await asyncio.sleep(interval)

        await asyncio.gather(*tasks)
        result.elapsed = time.perf_counter() - result.started

    return result


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, round(p / 100 * len(ordered)) - 1))
    return ordered[k]


def run(args) -> None:
    if not args.api_key:
        raise SystemExit(
            "loadgen: gateway mode needs an API key.\n"
            "  Grab the one the gateway prints at boot:\n"
            "    docker compose logs gateway | grep -o 'tb_[a-f0-9]*' | tail -1\n"
            "  then pass it with --api-key (or set GATEWAY_API_KEY)."
        )

    print(
        f"loadgen: calling {args.url} at ~{args.rps} rps for {args.duration}s "
        f"({'unique prompts' if args.distinct == 0 else f'{args.distinct} distinct prompts'})"
    )

    result = asyncio.run(_run(args))
    latencies = result.latencies_ms
    total = sum(result.statuses.values())
    rate = total / result.elapsed if result.elapsed else 0

    print(f"loadgen: {total} calls in {result.elapsed:.1f}s ({rate:.0f}/s effective)")
    print("  status  " + "  ".join(f"{code}: {n}" for code, n in sorted(result.statuses.items(), key=str)))
    if latencies:
        print(
            f"  latency mean {statistics.mean(latencies):.0f}ms"
            f"  p50 {_percentile(latencies, 50):.0f}ms"
            f"  p95 {_percentile(latencies, 95):.0f}ms"
            f"  p99 {_percentile(latencies, 99):.0f}ms"
            f"  max {max(latencies):.0f}ms"
        )
    if result.cache:
        print("  cache   " + "  ".join(f"{k}: {v}" for k, v in sorted(result.cache.items())))
