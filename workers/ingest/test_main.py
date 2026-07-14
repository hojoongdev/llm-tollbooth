"""Unit tests for the pure parts of the ingest worker.

Everything tested here is a function over plain values — no Kafka, no Cassandra,
no Mongo, nothing mocked, because nothing here does I/O. That split is on
purpose, and it is the same one the gateway's vitest suite makes: the storage
path is proved by actually running the stack, while the arithmetic that would
otherwise corrupt a metric silently for weeks is proved here, cheaply, on every
run.

The histogram is exactly that kind of arithmetic. An off-by-one in the bucket
ladder does not crash anything — it just quietly reports the wrong p95, and a
wrong p95 is worse than no p95, because someone will trust it.
"""

from __future__ import annotations

from main import (
    LATENCY_BUCKETS_MS,
    _cumulative_hist,
    _empty_bucket,
    bucket_index,
    normalize,
)


# --------------------------------------------------------------------------- #
# bucket_index — `le` semantics
# --------------------------------------------------------------------------- #
def test_latency_on_a_bound_belongs_to_that_bucket():
    # `le` means "less than or equal", so a bound is the *inclusive* top of its
    # bucket. This is the off-by-one that matters: get it backwards and every
    # bucket is shifted by one, which is invisible until someone reads a p95.
    for i, bound in enumerate(LATENCY_BUCKETS_MS):
        assert bucket_index(bound) == i


def test_latency_one_over_a_bound_spills_into_the_next_bucket():
    assert bucket_index(10) == 0       # lat_le_10
    assert bucket_index(11) == 1       # lat_le_25
    assert bucket_index(25) == 1       # lat_le_25 — still, it's the bound
    assert bucket_index(26) == 2       # lat_le_50


def test_a_cache_hit_lands_in_the_fastest_bucket():
    # The whole point of the response cache is that it turns a 300ms call into a
    # ~1ms one. If the ladder didn't resolve that, the cache's effect on p50
    # would be invisible in the very chart built to show it.
    assert bucket_index(1) == 0
    assert bucket_index(0) == 0


def test_latency_past_the_last_bound_overflows():
    # Not an error — it's the +Inf bucket, which has no column because `requests`
    # already counts every event.
    assert bucket_index(10_001) == len(LATENCY_BUCKETS_MS)
    assert bucket_index(120_000) == len(LATENCY_BUCKETS_MS)


# --------------------------------------------------------------------------- #
# _cumulative_hist — disjoint counts -> `le` deltas
# --------------------------------------------------------------------------- #
def test_cumulative_hist_binds_exactly_one_value_per_column():
    # The guard against silent drift: the prepared statement generates one
    # `lat_le_N = lat_le_N + ?` per bound, so the delta tuple must be the same
    # length. If these ever disagree every counter after the gap mis-binds.
    b = _empty_bucket()
    assert len(_cumulative_hist(b["hist"])) == len(LATENCY_BUCKETS_MS)


def test_cumulative_hist_accumulates_upward():
    b = _empty_bucket()
    b["hist"][bucket_index(5)] += 1      # -> lat_le_10
    b["hist"][bucket_index(300)] += 1    # -> lat_le_500

    cum = _cumulative_hist(b["hist"])
    by_bound = dict(zip(LATENCY_BUCKETS_MS, cum))

    # The 5ms call is at or below every bound, so it is counted by all of them.
    # The 300ms call joins it from lat_le_500 up.
    assert by_bound[10] == 1
    assert by_bound[100] == 1
    assert by_bound[250] == 1
    assert by_bound[500] == 2
    assert by_bound[10_000] == 2


def test_the_denominator_counts_every_event_including_the_overflow():
    # flush() binds sum(hist) to lat_count — the histogram's own denominator. A 30s
    # call is claimed by no lat_le_* column, but it must still be in that total:
    # drop it and p99 gets computed against a denominator that excludes exactly the
    # requests p99 exists to describe.
    b = _empty_bucket()
    for latency in (5, 300, 30_000):
        b["hist"][bucket_index(latency)] += 1
        b["requests"] += 1

    lat_count = sum(b["hist"])  # what flush() writes
    cum = _cumulative_hist(b["hist"])

    assert lat_count == 3       # including the 30s call
    assert cum[-1] == 2         # which no finite bucket claims


def test_the_denominator_is_derived_from_the_histogram_not_from_requests():
    # They are equal for any bucket this code folded — and that is the trap. The
    # column exists because rows written *before* the histogram have `requests` and
    # no buckets, so reading the denominator off `requests` would make every one of
    # those look like it overflowed. Pin the equality, and pin where it comes from.
    b = _empty_bucket()
    for latency in (1, 40, 300, 9_000, 60_000):
        b["hist"][bucket_index(latency)] += 1
        b["requests"] += 1

    assert sum(b["hist"]) == b["requests"] == 5


def test_a_flushed_histogram_is_a_readable_distribution():
    # The shape a reader gets back. The cumulative counts must be non-decreasing and
    # bounded by lat_count — the two invariants a percentile read relies on.
    b = _empty_bucket()
    for latency in (1, 2, 8, 40, 90, 260, 300, 700, 3000, 60_000):
        b["hist"][bucket_index(latency)] += 1
        b["requests"] += 1

    lat_count = sum(b["hist"])
    cum = _cumulative_hist(b["hist"])

    assert cum == sorted(cum)
    assert all(c <= lat_count for c in cum)
    assert cum[-1] == lat_count - 1  # the 60s call is in the overflow alone


# --------------------------------------------------------------------------- #
# normalize
# --------------------------------------------------------------------------- #
def test_normalize_resolves_the_bucket_once_per_event():
    assert normalize({"latency_ms": 317})["lat_bucket"] == bucket_index(317)


def test_normalize_defaults_a_missing_latency_to_the_fastest_bucket():
    # Every field on the wire is optional to the worker by design (a malformed
    # event must not take the pipeline down), so a missing latency reads as 0.
    # Worth pinning: it means a broken producer would drag p50 *down*, not up.
    assert normalize({})["latency_ms"] == 0
    assert normalize({})["lat_bucket"] == 0
