"""Unit tests for the eval worker's judgment — the parts that decide what gets scored
and what a score means. All pure: no Kafka, no Cassandra, no Mongo, no judge (§14)."""

from __future__ import annotations

import json

import pytest

from main import (
    EVAL_KEY_ID,
    EVAL_TAG,
    clamp_score,
    dims_of,
    flatten_prompt,
    heuristic_scores,
    judge_messages,
    overall_score,
    parse_scores,
    should_sample,
)


# --------------------------------------------------------------------------- #
# parse_scores — reading the judge's answer
# --------------------------------------------------------------------------- #
def test_parse_scores_reads_a_clean_json_object():
    text = '{"relevance":5,"hallucination_risk":1,"tone":4,"reason":"answered it"}'
    assert parse_scores(text) == {
        "relevance": 5,
        "hallucination_risk": 1,
        "tone": 4,
        "reason": "answered it",
    }


def test_parse_scores_digs_the_json_out_of_surrounding_prose():
    # Judges are told to return only JSON and routinely don't. Taking the outermost
    # {...} is the difference between a working evaluation and one that silently falls
    # back to the heuristic on every call.
    text = 'Sure! Here is my assessment:\n{"relevance":4,"hallucination_risk":2,"tone":5}\nHope that helps.'
    scores = parse_scores(text)
    assert scores["relevance"] == 4
    assert scores["tone"] == 5


def test_parse_scores_clamps_a_score_outside_1_to_5():
    text = '{"relevance":9,"hallucination_risk":0,"tone":3.4}'
    scores = parse_scores(text)
    # A 9 is a strong signal and a 0 a weak one — coerce them into the scale rather
    # than throwing away a judgment that was clearly made.
    assert scores["relevance"] == 5
    assert scores["hallucination_risk"] == 1
    assert scores["tone"] == 3


def test_parse_scores_is_none_when_the_reply_has_no_scores():
    # This is the mock provider's path: it returns prose, not a rubric. None here is
    # what sends the caller to the heuristic.
    assert parse_scores("[mock] You asked: ...") is None
    assert parse_scores("") is None
    assert parse_scores(None) is None


def test_parse_scores_is_none_when_an_axis_is_missing():
    # Two of three axes is not a score. Guessing the third would invent a number and
    # then average it into the rollup as though a model had said it.
    assert parse_scores('{"relevance":4,"tone":5}') is None


def test_parse_scores_is_none_on_malformed_json():
    assert parse_scores('{"relevance":4,') is None


@pytest.mark.parametrize("raw,expected", [(0, 1), (1, 1), (3, 3), (5, 5), (7, 5), (4.6, 5)])
def test_clamp_score(raw, expected):
    assert clamp_score(raw) == expected


# --------------------------------------------------------------------------- #
# overall_score — one number for the rollup and for quality_drop
# --------------------------------------------------------------------------- #
def test_overall_inverts_hallucination_risk():
    # High risk is *bad*, unlike the other two axes. A perfect answer that is likely
    # made up must not score the same as one that isn't.
    safe = overall_score({"relevance": 5, "tone": 5, "hallucination_risk": 1})
    risky = overall_score({"relevance": 5, "tone": 5, "hallucination_risk": 5})
    assert safe > risky
    assert safe == 5.0
    assert risky == pytest.approx(3.67, abs=0.01)


def test_overall_stays_on_the_1_to_5_scale():
    worst = overall_score({"relevance": 1, "tone": 1, "hallucination_risk": 5})
    best = overall_score({"relevance": 5, "tone": 5, "hallucination_risk": 1})
    assert worst == 1.0
    assert best == 5.0


# --------------------------------------------------------------------------- #
# heuristic_scores — the deterministic stand-in
# --------------------------------------------------------------------------- #
def test_heuristic_is_deterministic_and_derived_from_the_answer():
    # Same text, same score — a rollup that moved because a hash was re-rolled would
    # be a quality trend made of noise.
    assert heuristic_scores("an answer") == heuristic_scores("an answer")


def test_heuristic_varies_between_answers():
    # If every mock answer scored identically, the Quality screen would be a flat line
    # and a quality_drop rule could never trip in a demo.
    scores = {overall_score(heuristic_scores(f"answer {i}")) for i in range(30)}
    assert len(scores) > 1


def test_heuristic_stays_in_range():
    for i in range(50):
        s = heuristic_scores(f"answer {i}")
        assert 1 <= s["relevance"] <= 5
        assert 1 <= s["hallucination_risk"] <= 5
        assert 1 <= s["tone"] <= 5
        assert 1.0 <= overall_score(s) <= 5.0


# --------------------------------------------------------------------------- #
# should_sample — what is worth a judge call
# --------------------------------------------------------------------------- #
BASE_SETTINGS = {"enabled": True, "sample_rate": 1.0, "models": [], "keys": []}


def event(**over) -> dict:
    return {
        "status": "success",
        "model": "gpt-4o",
        "api_key_id": "key_abc",
        "feature_tag": None,
        **over,
    }


def test_samples_a_successful_call():
    assert should_sample(event(), BASE_SETTINGS, 0.0) is True


@pytest.mark.parametrize("status", ["error", "blocked", "cached"])
def test_skips_anything_that_is_not_a_success(status):
    # A blocked or errored call has no answer to grade. A cached one was already graded
    # the first time it was answered — scoring it again would pay a judge call to
    # re-score identical text and double its weight in the average.
    assert should_sample(event(status=status), BASE_SETTINGS, 0.0) is False


def test_never_samples_the_workers_own_judge_calls():
    # The loop this prevents: a judge call is traffic, traffic gets sampled, a sample
    # is a judge call. Belt and braces — by tag, and by the key the worker uses.
    assert should_sample(event(feature_tag=EVAL_TAG), BASE_SETTINGS, 0.0) is False
    assert should_sample(event(api_key_id=EVAL_KEY_ID), BASE_SETTINGS, 0.0) is False


def test_sample_rate_is_the_dice_roll():
    tenth = {**BASE_SETTINGS, "sample_rate": 0.1}
    assert should_sample(event(), tenth, 0.05) is True
    assert should_sample(event(), tenth, 0.5) is False
    # 0 means off entirely, and must not sample on a roll of exactly 0.0.
    assert should_sample(event(), {**BASE_SETTINGS, "sample_rate": 0.0}, 0.0) is False


def test_model_and_key_filters_narrow_what_is_evaluated():
    only_mini = {**BASE_SETTINGS, "models": ["gpt-4o-mini"]}
    assert should_sample(event(model="gpt-4o"), only_mini, 0.0) is False
    assert should_sample(event(model="gpt-4o-mini"), only_mini, 0.0) is True

    only_key = {**BASE_SETTINGS, "keys": ["key_xyz"]}
    assert should_sample(event(api_key_id="key_abc"), only_key, 0.0) is False
    assert should_sample(event(api_key_id="key_xyz"), only_key, 0.0) is True


def test_disabled_settings_stop_all_sampling():
    assert should_sample(event(), {**BASE_SETTINGS, "enabled": False}, 0.0) is False


# --------------------------------------------------------------------------- #
# The rest
# --------------------------------------------------------------------------- #
def test_dims_match_the_ingest_workers_rollup_axes():
    # A score has to land on the very rows the other metrics occupy, or the Quality
    # screen would be reading a different partition than the cost chart next to it.
    assert dims_of("gpt-4o", "key_abc") == ("all", "model:gpt-4o", "key:key_abc")
    assert dims_of("", "") == ("all", "model:unknown", "key:unknown")


def test_flatten_prompt_includes_every_turn():
    doc = {"request": {"messages": [
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "what is a tollbooth"},
    ]}}
    assert flatten_prompt(doc) == "be terse\nwhat is a tollbooth"
    assert flatten_prompt({}) == ""


def test_judge_prompt_carries_the_rubric_and_the_call_being_graded():
    msgs = judge_messages("the question", "the answer")
    assert msgs[0]["role"] == "system"
    assert "relevance" in msgs[0]["content"]
    assert "the question" in msgs[1]["content"]
    assert "the answer" in msgs[1]["content"]
    # The rubric has to demand JSON, or parse_scores has nothing to find.
    assert "JSON" in msgs[0]["content"]


def test_a_judge_reply_in_the_rubrics_own_shape_parses():
    # Guards the rubric and the parser against drifting apart: the exact shape the
    # system prompt asks for must be the shape parse_scores accepts.
    reply = json.dumps({"relevance": 4, "hallucination_risk": 2, "tone": 5, "reason": "ok"})
    assert parse_scores(reply)["relevance"] == 4
