"""Unit tests for the rule judgment.

Spec §14 asks for these by name, and the reason is worth stating: a rule that fails
to fire is silent, and a rule that fires when it shouldn't teaches its owner to
ignore it. Neither failure announces itself. So the judgment is a pure function over
an already-fetched window — no Cassandra, no Mongo, no Kafka — and it gets pinned
here, cheaply, on every run.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from main import (
    EMPTY_WINDOW,
    Window,
    dims_of,
    evaluate,
    metric_value,
    percentile,
    window_days,
)

# The ladder and a histogram lifted straight off the running system: 383 synthetic
# events, read back out of rollup_hourly. Pinning real counters rather than invented
# ones means these tests fail if the reader ever stops agreeing with the console.
BOUNDS = (10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)
HIST = [0, 0, 0, 0, 4, 41, 94, 291, 370, 383]
LAT_COUNT = 383


# --------------------------------------------------------------------------- #
# percentile
# --------------------------------------------------------------------------- #
def test_percentile_matches_the_console():
    # The console rendered p50 1.74s / p95 4.81s / p99 8.53s off exactly these
    # counters. A rule firing on p95 and a chart showing p95 must not disagree about
    # the same window — that would be worse than having neither.
    assert percentile(BOUNDS, HIST, LAT_COUNT, 0.50) == pytest.approx(1742.4, abs=0.1)
    assert percentile(BOUNDS, HIST, LAT_COUNT, 0.95) == pytest.approx(4805.4, abs=0.1)
    assert percentile(BOUNDS, HIST, LAT_COUNT, 0.99) == pytest.approx(8526.9, abs=0.1)


def test_percentile_divides_by_the_histograms_own_count():
    # The bug this guards: `requests` also counts hours written before the histogram
    # existed, which have no buckets at all. Divide by it and those requests look like
    # they all overflowed the top bucket, dragging p95 to the ceiling.
    #
    # Same histogram, a denominator inflated the way a pre-histogram hour would
    # inflate it. p95 must not move, because lat_count did not.
    assert percentile(BOUNDS, HIST, LAT_COUNT, 0.95) == pytest.approx(4805.4, abs=0.1)
    assert percentile(BOUNDS, HIST, LAT_COUNT + 400, 0.95) == pytest.approx(10000.0)
    #                                       ^^^^^^^ what reading `requests` would do


def test_percentile_of_nothing_is_nothing():
    # An hour with no traffic is not an hour that was infinitely slow.
    assert percentile(BOUNDS, [0] * len(BOUNDS), 0, 0.95) == 0.0


def test_percentile_interpolates_inside_the_bucket_it_lands_in():
    # Everything in (100, 250]: the median sits halfway across that bucket, not at
    # either edge. The bucket's width is the error bar on the answer.
    hist = [0, 0, 0, 0, 100, 100, 100, 100, 100, 100]
    assert percentile(BOUNDS, hist, 100, 0.50) == pytest.approx(175.0)


def test_percentile_past_the_last_bound_reports_the_floor():
    # Every request took longer than 10s. There is no top to interpolate against, so
    # the honest answer is "at least the last bound" rather than a made-up number.
    assert percentile(BOUNDS, [0] * len(BOUNDS), 50, 0.95) == 10000.0


# --------------------------------------------------------------------------- #
# metric_value
# --------------------------------------------------------------------------- #
def test_every_spec_metric_is_readable_off_a_window():
    w = Window(cost=7.5, requests=200, errors=10, tokens=45_000, latency_p95=4805.4)
    assert metric_value("cost", w) == 7.5
    assert metric_value("tokens", w) == 45_000
    assert metric_value("latency_p95", w) == 4805.4
    assert metric_value("request_count", w) == 200
    assert metric_value("error_rate", w) == pytest.approx(0.05)


def test_error_rate_of_no_requests_is_zero_not_a_crash():
    # A scope with no traffic must not divide by zero, and must not read as 100%
    # broken — which is what an alert on error_rate would otherwise see the moment a
    # key went quiet.
    assert metric_value("error_rate", EMPTY_WINDOW) == 0.0


def test_an_unknown_metric_is_an_error_not_a_zero():
    # Silently reading 0 for a typo'd metric would make the rule permanently unable to
    # fire, and look perfectly healthy doing it.
    with pytest.raises(ValueError, match="unknown metric"):
        metric_value("latency_p50", EMPTY_WINDOW)


# --------------------------------------------------------------------------- #
# evaluate
# --------------------------------------------------------------------------- #
def test_a_cost_rule_fires_once_the_window_is_over_the_threshold():
    # The spec's own completion criterion for P4: cost over $X in an hour.
    condition = {"type": "metric_threshold", "metric": "cost", "threshold": 5.0}

    tripped, observed = evaluate(condition, Window(7.42, 300, 0, 1000, 0.0))
    assert tripped and observed == 7.42

    tripped, observed = evaluate(condition, Window(4.99, 300, 0, 1000, 0.0))
    assert not tripped and observed == 4.99


def test_touching_the_threshold_is_not_crossing_it():
    # Strictly greater. "$5 spent on a $5 threshold" reads as over to a budget (which
    # is a cap) and as not-yet to an alert (which is a warning about exceeding). The
    # gateway's budgetVerdict deliberately uses >=; this deliberately does not.
    condition = {"type": "metric_threshold", "metric": "cost", "threshold": 5.0}
    tripped, _ = evaluate(condition, Window(5.0, 1, 0, 0, 0.0))
    assert not tripped


def test_a_zero_threshold_does_not_fire_on_an_idle_scope():
    # The degenerate rule: "alert me on any error at all". It must fire on one error
    # and stay quiet on none — with >= it would fire forever on a scope with nothing
    # in it.
    condition = {"type": "metric_threshold", "metric": "request_count", "threshold": 0}
    assert not evaluate(condition, EMPTY_WINDOW)[0]
    assert evaluate(condition, Window(0.0, 1, 0, 0, 0.0))[0]


def test_evaluate_reports_what_it_saw_even_when_it_does_not_fire():
    # The observed value is what the firing history records and what a human reads to
    # decide whether the threshold was set sensibly. It is not optional.
    condition = {"type": "metric_threshold", "metric": "error_rate", "threshold": 0.5}
    tripped, observed = evaluate(condition, Window(0.0, 200, 20, 0, 0.0))
    assert not tripped
    assert observed == pytest.approx(0.1)


def test_metric_threshold_is_the_default_condition_type():
    assert evaluate({"metric": "cost", "threshold": 1.0}, Window(2.0, 1, 0, 0, 0.0))[0]


def test_an_unknown_condition_type_is_an_error():
    # quality_drop and keyword_match are spec'd but not built. A rule asking for one
    # must be refused loudly, not silently treated as a cost threshold.
    with pytest.raises(ValueError, match="unknown condition type"):
        evaluate({"type": "quality_drop", "threshold": 0.5}, EMPTY_WINDOW)


# --------------------------------------------------------------------------- #
# window_days — which partitions a window touches
# --------------------------------------------------------------------------- #
def test_a_one_hour_window_starts_at_the_top_of_the_hour():
    # The rollup is hourly, so a 1h window reaches back into the previous bucket. That
    # is a property of hourly buckets; what matters is that the console does the same
    # arithmetic, so a rule and the chart used to check it agree.
    now = datetime(2026, 7, 13, 14, 30, tzinfo=timezone.utc)
    days, start = window_days(1, now)
    assert days == [date(2026, 7, 13)]
    assert start == datetime(2026, 7, 13, 13, 0, tzinfo=timezone.utc)


def test_a_window_that_crosses_midnight_reads_both_day_partitions():
    # `day` is in the partition key. Miss the second partition and the rule silently
    # evaluates against half its window — every night, for an hour.
    now = datetime(2026, 7, 13, 0, 30, tzinfo=timezone.utc)
    days, start = window_days(1, now)
    assert days == [date(2026, 7, 12), date(2026, 7, 13)]
    assert start == datetime(2026, 7, 12, 23, 0, tzinfo=timezone.utc)


def test_a_24h_window_spans_two_day_partitions():
    now = datetime(2026, 7, 13, 14, 30, tzinfo=timezone.utc)
    days, _ = window_days(24, now)
    assert days == [date(2026, 7, 12), date(2026, 7, 13)]


# --------------------------------------------------------------------------- #
# dims_of — the stream tells us which scopes could have moved
# --------------------------------------------------------------------------- #
def test_an_event_activates_exactly_the_three_axes_the_rollup_keeps():
    # These must be the same three strings the ingest worker increments, or a rule
    # scoped to a key would never be told that key made a call.
    assert dims_of({"model": "gpt-4o", "api_key_id": "key_abc"}) == (
        "all",
        "model:gpt-4o",
        "key:key_abc",
    )


def test_a_field_less_event_still_maps_onto_the_axes_ingest_wrote():
    # ingest defaults a missing model/key to "unknown" and rolls it up under that
    # name. If this defaulted differently, the rule would watch a dim that has no row.
    assert dims_of({}) == ("all", "model:unknown", "key:unknown")
