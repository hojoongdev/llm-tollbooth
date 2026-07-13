"""Unit tests for the rule judgment.

Spec §14 asks for these by name, and the reason is worth stating: a rule that fails
to fire is silent, and a rule that fires when it shouldn't teaches its owner to
ignore it. Neither failure announces itself. So the judgment is a pure function over
an already-fetched window — no Cassandra, no Mongo, no Kafka — and it gets pinned
here, cheaply, on every run.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone

import pytest

from main import (
    EMPTY_WINDOW,
    Window,
    budget_days,
    condition_kind,
    dims_of,
    email_body,
    evaluate_budget,
    evaluate_threshold,
    firing_doc,
    keyword_hit,
    metric_value,
    percentile,
    prompt_text,
    response_text,
    scope_query,
    trigger_text,
    webhook_payload,
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
# condition_kind — refuse what you cannot answer
# --------------------------------------------------------------------------- #
def test_metric_threshold_is_the_default_condition_type():
    assert condition_kind({}) == "metric_threshold"
    assert condition_kind({"metric": "cost", "threshold": 1.0}) == "metric_threshold"


def test_every_built_condition_is_recognised():
    for kind in ("metric_threshold", "budget_percent", "keyword_match"):
        assert condition_kind({"type": kind}) == kind


def test_an_unknown_condition_type_is_an_error():
    # quality_drop is spec'd for P5, after Eval. A rule asking for it must be refused
    # loudly — silently treating it as a cost threshold would leave someone with a rule
    # that looks armed on the screen and is watching something else entirely.
    with pytest.raises(ValueError, match="unknown condition type"):
        condition_kind({"type": "quality_drop", "threshold": 0.5})


# --------------------------------------------------------------------------- #
# evaluate_threshold
# --------------------------------------------------------------------------- #
def test_a_cost_rule_fires_once_the_window_is_over_the_threshold():
    # The spec's own completion criterion for P4: cost over $X in an hour.
    condition = {"type": "metric_threshold", "metric": "cost", "threshold": 5.0}

    tripped, observed = evaluate_threshold(condition, Window(7.42, 300, 0, 1000, 0.0))
    assert tripped and observed == 7.42

    tripped, observed = evaluate_threshold(condition, Window(4.99, 300, 0, 1000, 0.0))
    assert not tripped and observed == 4.99


def test_touching_a_threshold_is_not_crossing_it():
    # Strictly greater — this condition reads "over X". (budget_percent goes the other
    # way, and the next block explains why that is not an inconsistency.)
    condition = {"type": "metric_threshold", "metric": "cost", "threshold": 5.0}
    assert not evaluate_threshold(condition, Window(5.0, 1, 0, 0, 0.0))[0]


def test_a_zero_threshold_does_not_fire_on_an_idle_scope():
    # The degenerate rule: "alert me on any traffic at all". It must fire on one request
    # and stay quiet on none — with >= it would fire forever on a scope with nothing in it.
    condition = {"type": "metric_threshold", "metric": "request_count", "threshold": 0}
    assert not evaluate_threshold(condition, EMPTY_WINDOW)[0]
    assert evaluate_threshold(condition, Window(0.0, 1, 0, 0, 0.0))[0]


def test_evaluate_reports_what_it_saw_even_when_it_does_not_fire():
    # The observed value is what the firing history records and what a human reads to
    # decide whether the threshold was set sensibly. It is not optional.
    condition = {"type": "metric_threshold", "metric": "error_rate", "threshold": 0.5}
    tripped, observed = evaluate_threshold(condition, Window(0.0, 200, 20, 0, 0.0))
    assert not tripped
    assert observed == pytest.approx(0.1)


# --------------------------------------------------------------------------- #
# evaluate_budget — "예산의 N% 도달"
# --------------------------------------------------------------------------- #
def test_a_budget_rule_reports_the_percentage_of_the_cap_that_is_gone():
    # The percentage, not the dollars: it is the one number that means the same thing
    # whether the cap is $5 or $5,000.
    condition = {"type": "budget_percent", "percent": 80}
    tripped, observed = evaluate_budget(condition, spent=4.36, cap=5.00)
    assert tripped
    assert observed == pytest.approx(87.2)


def test_a_budget_rule_stays_quiet_below_its_percentage():
    condition = {"type": "budget_percent", "percent": 80}
    tripped, observed = evaluate_budget(condition, spent=3.00, cap=5.00)
    assert not tripped
    assert observed == pytest.approx(60.0)


def test_reaching_the_percentage_is_enough():
    # `>=`, unlike the threshold above, and deliberately. The spec says 도달 — *reached* —
    # and it is the comparison the gateway makes when it decides to start refusing the
    # call. An alert at 100% that only fired once the key had gone strictly *past* its cap
    # would be telling you about a fire you were already standing in.
    condition = {"type": "budget_percent", "percent": 100}
    assert evaluate_budget(condition, spent=5.00, cap=5.00)[0]


def test_a_budget_rule_on_a_key_with_no_budget_is_an_error_not_a_zero():
    # A rule watching a cap that does not exist can never be right. Reporting 0% would
    # say the opposite of "this rule is broken", and it would say it forever.
    condition = {"type": "budget_percent", "percent": 80}
    with pytest.raises(ValueError, match="needs a key with a budget"):
        evaluate_budget(condition, spent=4.00, cap=None)
    with pytest.raises(ValueError, match="needs a key with a budget"):
        evaluate_budget(condition, spent=4.00, cap=0)


# --------------------------------------------------------------------------- #
# budget_days — a calendar, not a rolling window
# --------------------------------------------------------------------------- #
def test_a_daily_budget_reads_todays_partition_and_only_that():
    # "80% of today's cap" means all of today — not the last 24 hours, which would drag in
    # yesterday evening and report a number the gateway has never heard of.
    now = datetime(2026, 7, 13, 14, 30, tzinfo=timezone.utc)
    assert budget_days("daily", now) == [date(2026, 7, 13)]


def test_a_monthly_budget_reads_every_day_of_the_month_so_far():
    # The same partitions the gateway's daysOfMonth reads. Miss one and the alert and the
    # enforcement are talking about different budgets.
    now = datetime(2026, 7, 13, 14, 30, tzinfo=timezone.utc)
    days = budget_days("monthly", now)
    assert days[0] == date(2026, 7, 1)
    assert days[-1] == date(2026, 7, 13)
    assert len(days) == 13


def test_an_unknown_budget_period_is_refused():
    with pytest.raises(ValueError, match="unknown budget period"):
        budget_days("weekly", datetime(2026, 7, 13, tzinfo=timezone.utc))


# --------------------------------------------------------------------------- #
# keyword_match — the one condition no rollup can answer
# --------------------------------------------------------------------------- #
DOC = {
    "request": {
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is my API key?"},
        ]
    },
    "response": {"content": "I can't share a PASSWORD or any credential."},
}


def test_the_whole_conversation_is_searched_not_just_the_last_turn():
    # A keyword can hide in any turn, the system prompt included. Searching only the last
    # message would miss exactly the case someone writes a keyword rule for.
    text = prompt_text(DOC)
    assert "helpful assistant" in text
    assert "API key" in text


def test_matching_is_case_insensitive():
    # Someone watching for "password" means the word. A rule that sailed past "PASSWORD"
    # would be a rule that quietly did not work — the worst kind, because it looks armed
    # the entire time it is missing things.
    hit = keyword_hit({"keyword": "password"}, prompt_text(DOC), response_text(DOC))
    assert hit == "response"


def test_a_keyword_rule_can_watch_one_side_of_the_call():
    prompt, answer = prompt_text(DOC), response_text(DOC)
    # "api key" is in the prompt only.
    assert keyword_hit({"keyword": "api key", "matched_in": "prompt"}, prompt, answer) == "prompt"
    assert keyword_hit({"keyword": "api key", "matched_in": "response"}, prompt, answer) is None
    # "password" is in the response only.
    assert keyword_hit({"keyword": "password", "matched_in": "prompt"}, prompt, answer) is None
    assert keyword_hit({"keyword": "password", "matched_in": "response"}, prompt, answer) == "response"


def test_a_keyword_that_is_in_neither_does_not_match():
    assert keyword_hit({"keyword": "kubernetes"}, prompt_text(DOC), response_text(DOC)) is None


def test_a_keyword_rule_with_no_keyword_is_an_error():
    # It would otherwise match the empty string — which is in every request ever made.
    with pytest.raises(ValueError, match="no keyword"):
        keyword_hit({"keyword": "   "}, "some prompt", "some answer")


def test_a_document_with_no_body_searches_as_empty_rather_than_crashing():
    # Synthetic loadgen events have no request document body at all. A keyword rule must
    # find nothing in them, not fall over on the whole event stream.
    assert prompt_text({}) == ""
    assert response_text({}) == ""
    assert response_text({"response": None}) == ""
    assert keyword_hit({"keyword": "password"}, prompt_text({}), response_text({})) is None


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


# --------------------------------------------------------------------------- #
# scope_query — the Mongo mirror of the rollup dim
# --------------------------------------------------------------------------- #
START = datetime(2026, 7, 13, 13, 0, tzinfo=timezone.utc)
NOW = datetime(2026, 7, 13, 14, 30, tzinfo=timezone.utc)


def test_a_scoped_query_selects_the_same_requests_the_counters_counted():
    # The `tag` action labels the requests that made up the breach. If this selected a
    # different set than the rollup dim aggregated, the tag would point at the wrong
    # calls — and look authoritative doing it.
    assert scope_query("key:key_abc", START, NOW) == {
        "ts": {"$gte": START, "$lte": NOW},
        "api_key_id": "key_abc",
    }
    assert scope_query("model:gpt-4o", START, NOW) == {
        "ts": {"$gte": START, "$lte": NOW},
        "model": "gpt-4o",
    }
    assert scope_query("all", START, NOW) == {"ts": {"$gte": START, "$lte": NOW}}


def test_a_scope_is_always_bounded_by_the_window():
    # Every branch carries the ts bound. Drop it on one and a tag action would sweep
    # the entire retention period instead of the hour that actually tripped.
    for scope in ("all", "model:gpt-4o", "key:key_abc"):
        assert scope_query(scope, START, NOW)["ts"] == {"$gte": START, "$lte": NOW}


def test_an_unknown_scope_is_refused_rather_than_matching_everything():
    # A typo'd scope must not silently degrade into "all" — that would tag, or block,
    # far more than the rule asked for.
    with pytest.raises(ValueError, match="unknown scope"):
        scope_query("project:default", START, NOW)


# --------------------------------------------------------------------------- #
# What the human receives
# --------------------------------------------------------------------------- #
def _threshold_firing() -> tuple[dict, dict]:
    rule = {
        "_id": "rule_cost",
        "name": "Hourly spend over $1.50",
        "scope": "key:key_abc",
        "condition": {"metric": "cost", "window_hours": 1, "threshold": 1.5},
        "cooldown_seconds": 1800,
    }
    return rule, firing_doc(rule, "metric_threshold", 2.38916, NOW)


def _budget_firing() -> tuple[dict, dict]:
    rule = {
        "_id": "rule_budget",
        "name": "Daily budget nearly gone",
        "scope": "key:key_abc",
        "condition": {"type": "budget_percent", "period": "daily", "percent": 80},
        "cooldown_seconds": 1800,
    }
    return rule, firing_doc(
        rule, "budget_percent", 87.2, NOW, period="daily", spent=4.36, cap=5.0
    )


def _keyword_firing() -> tuple[dict, dict]:
    rule = {
        "_id": "rule_leak",
        "name": "Credential leak",
        "scope": "all",
        "condition": {"type": "keyword_match", "keyword": "password", "matched_in": "response"},
        "cooldown_seconds": 1800,
    }
    return rule, firing_doc(
        rule, "keyword_match", 1.0, NOW,
        keyword="password", matched_in="response", request_id="909bb70f",
    )


def test_each_condition_type_describes_itself_in_its_own_terms():
    # Three conditions answer three different questions, and the fields that make one of
    # them legible are meaningless on the others. So the sentence is composed once, at the
    # moment it is true, and the email, the webhook and the console all repeat that one.
    assert "cost 2.38916 over 1.5 in the last 1h" in _threshold_firing()[1]["detail"]
    assert "87.2% of the daily budget" in _budget_firing()[1]["detail"]
    assert "alerts at 80%" in _budget_firing()[1]["detail"]
    assert "'password' found in the response" in _keyword_firing()[1]["detail"]


def test_the_email_says_what_tripped_and_when_it_will_speak_again():
    # An alert that only says "a rule fired" makes its reader go and look, which is exactly
    # the work the alert existed to save.
    rule, firing = _threshold_firing()
    body = email_body(rule, firing)

    assert "Hourly spend over $1.50" in body   # which rule
    assert "key:key_abc" in body               # on what
    assert "cost 2.38916 over 1.5" in body     # by how much
    assert "1800s" in body                     # and when they'll hear from it again


def test_a_keyword_alert_names_the_request_that_tripped_it():
    # The first thing anyone does on a leak alert is go and read the call that leaked. The
    # mail has to say which one, or it has sent them hunting.
    rule, firing = _keyword_firing()
    body = email_body(rule, firing)
    assert "'password' found in the response" in body
    assert "909bb70f" in body


def test_a_budget_alert_carries_the_dollars_as_well_as_the_percent():
    # "87% of your budget" is the sentence; "$4.36 of $5" is what makes it actionable.
    rule, firing = _budget_firing()
    body = email_body(rule, firing)
    assert "87.2%" in body
    assert "$4.36" in body and "$5" in body


def test_one_webhook_payload_reads_in_slack_discord_and_anything_else():
    # Slack renders `text`, Discord renders `content`. Sending both costs nothing and saves
    # a per-vendor template, which is the kind of thing that rots quietly.
    rule, firing = _threshold_firing()
    payload = webhook_payload(rule, firing)

    assert payload["text"] == payload["content"]
    assert "cost 2.38916 over 1.5" in payload["text"]
    # The structured fields are there for anything that isn't a chat app.
    assert payload["rule_id"] == "rule_cost"
    assert payload["condition_type"] == "metric_threshold"
    assert payload["observed"] == 2.38916
    assert payload["scope"] == "key:key_abc"


def test_the_webhook_carries_whatever_the_condition_had_to_say_about_itself():
    # A budget firing has a period and a cap; a keyword firing has a word and a request id.
    # Neither shape should have to be reconstructed by whoever receives it.
    assert webhook_payload(*_budget_firing())["period"] == "daily"
    assert webhook_payload(*_budget_firing())["cap"] == 5.0
    assert webhook_payload(*_keyword_firing())["keyword"] == "password"
    assert webhook_payload(*_keyword_firing())["request_id"] == "909bb70f"
    # ...and nothing carries a field that does not apply to it.
    assert "keyword" not in webhook_payload(*_budget_firing())


def test_every_payload_is_json_serialisable():
    # fired_at is a datetime on the firing document and json.dumps would refuse it — the
    # payload has to hand over a string. This is the kind of thing that only fails in
    # production, at 3am, on the one path nobody exercised.
    for maker in (_threshold_firing, _budget_firing, _keyword_firing):
        payload = json.loads(json.dumps(webhook_payload(*maker())))
        assert payload["fired_at"].startswith("2026-07-13")
        assert payload["detail"]
