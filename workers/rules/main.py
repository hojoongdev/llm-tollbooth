"""rules worker — decide when something is worth telling someone about, then tell them.

A rule is a condition, a scope, a cooldown and a set of actions. This worker consumes
llm.events on its own Kafka consumer group, evaluates every enabled rule, and then emails,
posts a webhook, blocks the key or tags the requests that made up the breach.

Four conditions, and they are not all the same shape (spec §4 group C):

  metric_threshold  A window of traffic went over a line — cost, tokens, latency p95, error
                    rate, request count. Answered by the hourly rollup, on a timer.
  budget_percent    A key has reached N% of its daily or monthly cap. Also the rollup, but
                    over a *calendar* period rather than a rolling window, because that is
                    what a budget is and what the gateway enforces.
  keyword_match     A word turned up in a prompt or an answer. This one no rollup can
                    answer — the text is in neither the rollup nor the event — so it is the
                    one condition evaluated per event, against the request document, and
                    the one that samples.
  quality_drop      The average score the eval worker gave this scope has fallen below a
                    line. The rollup again — the eval worker writes quality counters onto
                    the same rows — but it is the one condition whose evidence does not
                    arrive on the event stream, and the one that tests *below* rather than
                    above. Both of those change how it has to be scheduled; see run_pass.

Why the rollup rather than the event stream:
  A rule asks a question about a *window* — "has this key spent more than $5 in the
  last hour" — and rollup_hourly already answers exactly that, cheaply, for exactly
  the axes rules are scoped to. A rule's `scope` is the rollup's `dim` verbatim:
  'all', 'model:gpt-4o', 'key:key_abc'. There is nothing to translate. Summing the
  events here instead would mean keeping our own window state, and then quietly
  disagreeing with the console about the same number — the console reads the rollup.

Why consume the stream at all, then:
  To know which scopes could possibly have moved. Every threshold here is an "over"
  test on a metric that only traffic can push up, so a key that made no calls since
  the last pass cannot have newly crossed anything: its window can only have shrunk
  as old hours age out. So the stream is read for its *dims*, and a pass evaluates
  only the rules whose scope actually saw a request. On a system with two hundred
  keys and traffic on three, that is three rollup reads instead of two hundred.

  (It is also where the keyword conditions will read from, since those are per-event
  by nature and cannot be answered by any rollup.)

Offsets are committed after a pass, never before — the same at-least-once shape the
ingest worker uses. Replay is harmless here in a way it is not there: conditions are
re-derived from the rollup on every pass rather than accumulated in this process, so
re-reading a batch of events cannot double-count anything into a threshold. It can
only cause a scope to be re-checked, which is idempotent.

Firing is once per cooldown, and the database enforces that, not this process — see
claim(). Unlike the ingest worker this one starts at the *latest* offset, not the
earliest: a monitor that boots up and replays a week of history would alarm about a
week of history.
"""

from __future__ import annotations

import json
import os
import random
import signal
import smtplib
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Sequence
from urllib import request as urlrequest

from cassandra.cluster import Cluster, Session
from cassandra.query import PreparedStatement
from confluent_kafka import Consumer, KafkaError
from pymongo import DESCENDING, MongoClient

# --- Kafka ---
TOPIC = os.environ.get("KAFKA_TOPIC", "llm.events")
# A group of our own: the same topic the ingest worker reads, consumed
# independently, with its own offsets. Neither worker can starve the other.
GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "rules")
BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092")

# --- Cassandra ---
CASSANDRA_CONTACT_POINTS = os.environ.get("CASSANDRA_CONTACT_POINTS", "localhost").split(",")
CASSANDRA_PORT = int(os.environ.get("CASSANDRA_PORT", "9042"))
CASSANDRA_KEYSPACE = os.environ.get("CASSANDRA_KEYSPACE", "tollbooth")

# --- MongoDB ---
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.environ.get("MONGO_DB", "tollbooth")

PROJECT = os.environ.get("PROJECT_ID", "default")

# How often a pass runs. Rules are windowed in hours, so evaluating more often than
# this buys nothing but Cassandra reads — and less often means an alert that matters
# shows up late.
EVAL_SECONDS = float(os.environ.get("RULES_EVAL_SECONDS", "20"))

# --- Alert delivery ---
# The defaults point at the bundled Mailpit, so a bare `docker compose up` has working
# email alerts with nothing to configure — and nothing real to leak. A production relay
# would set SMTP_USER, which is also the switch that turns on STARTTLS: Mailpit takes no
# credentials and offers no TLS, and demanding either would break the out-of-the-box path.
SMTP_HOST = os.environ.get("SMTP_HOST", "mailpit")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "1025"))
SMTP_FROM = os.environ.get("SMTP_FROM", "alerts@tollbooth.local")
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")

# An action reaches out to something that can hang — an SMTP relay, someone's webhook
# endpoint. It does so on the evaluation loop, so it gets a leash.
ACTION_TIMEOUT = float(os.environ.get("RULES_ACTION_TIMEOUT", "10"))

# --- Telling the gateway ---
# Blocking a key is a Mongo write, and the gateway caches key state for 30 seconds —
# so without this the block is advisory for half a minute (measured: 31s). These let
# the block take effect now instead. Unset, the block still lands; it just lands late.
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
GATEWAY_INTERNAL_TOKEN = os.environ.get("GATEWAY_INTERNAL_TOKEN", "")

# How many request documents one `tag` action will touch. A rule scoped to `all` over
# 24h could match every document in the window, and a firing must not turn into a
# minutes-long write storm. The cap is announced in the firing record rather than
# applied quietly — a tag that silently covered 5k of 40k requests would make the
# dashboard filter lie.
TAG_LIMIT = int(os.environ.get("RULES_TAG_LIMIT", "5000"))

# What fraction of matching requests a keyword rule actually opens and reads.
#
# It defaults to *all of them*, and that is a deliberate inversion of what "sampling
# based" usually implies. Sampling exists here to bound cost — a keyword rule is the one
# condition that costs a Mongo read per request, because the text it searches is in
# neither the rollup nor the event. But the thing people watch for keywords is a secret
# leaking, and a rule that samples 10% of a leak is a rule that misses nine times out of
# ten while looking like it is working. So the default catches everything, and turning it
# down is a decision someone makes on purpose, knowing the trade.
#
# The read only happens at all when a keyword rule is actually watching that scope.
KEYWORD_SAMPLE_RATE = float(os.environ.get("RULES_KEYWORD_SAMPLE_RATE", "1.0"))

# The condition types (spec §4 group C), all four of them now that Eval exists.
CONDITIONS = ("metric_threshold", "budget_percent", "keyword_match", "quality_drop")
# The metrics a threshold can be written against.
METRICS = ("cost", "tokens", "latency_p95", "error_rate", "request_count")
BUDGET_PERIODS = ("daily", "monthly")
KEYWORD_TARGETS = ("prompt", "response", "either")
ACTIONS = ("email", "webhook", "block", "tag")

# How many scored calls a quality_drop rule needs before it is willing to speak.
#
# Eval samples — at 10% an hour of light traffic might be judged once or twice — and an
# average over one sample is not an average. Paging someone because a single sampled
# answer scored a 2 is noise dressed as a signal, and the second time it happens they
# stop believing the alert. A rule can raise or lower its own floor; this is the default.
MIN_QUALITY_SAMPLES = int(os.environ.get("RULES_MIN_QUALITY_SAMPLES", "5"))

_running = True


def _stop(*_args) -> None:
    global _running
    _running = False


# --------------------------------------------------------------------------- #
# Connections
# --------------------------------------------------------------------------- #
def connect_cassandra() -> tuple[Cluster, Session]:
    """Connect to Cassandra, retrying while it (or the schema) comes up."""
    last_err: Exception | None = None
    for attempt in range(30):
        try:
            cluster = Cluster(CASSANDRA_CONTACT_POINTS, port=CASSANDRA_PORT)
            session = cluster.connect(CASSANDRA_KEYSPACE)
            return cluster, session
        except Exception as exc:  # noqa: BLE001 — surface any driver/connection error and retry
            last_err = exc
            print(f"rules: waiting for Cassandra ({attempt + 1}/30): {exc}", flush=True)
            time.sleep(2)
    raise RuntimeError(f"could not connect to Cassandra: {last_err}")


@dataclass
class Store:
    """The Mongo collections this worker touches.

    Two of them it owns (rules, rule_firings) and two it reaches into: `api_keys`,
    to block one, and `requests`, to tag some. Both of those already have other
    writers — the console owns api_keys, and the gateway and ingest worker each
    write half of every request document. So every write here is a targeted $set or
    $addToSet on a field nobody else touches, never a replace.
    """

    client: MongoClient
    rules: object
    firings: object
    api_keys: object
    requests: object


def connect_mongo() -> Store:
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]
    store = Store(
        client=client,
        rules=db["rules"],
        firings=db["rule_firings"],
        api_keys=db["api_keys"],
        requests=db["requests"],
    )
    # Idempotent, and created here rather than in a seed script for the same reason
    # every other index in this project is (see gateway/src/keys.ts): the service that
    # depends on an index is the service that should guarantee it.
    store.rules.create_index("enabled")
    store.firings.create_index([("fired_at", DESCENDING)])
    store.firings.create_index("rule_id")
    return store


def latency_bounds(session: Session) -> tuple[int, ...]:
    """The histogram's bucket ladder, read out of the schema instead of hardcoded.

    The bounds genuinely live in the lat_le_* column names — init.cql says so, and
    the ingest worker generates its UPDATE from the same list. Reading them back
    means this worker cannot drift from the table it is reading. Hardcoding a third
    copy would work right up until someone re-cut the ladder with an ALTER, at which
    point this would keep computing p95 off a histogram whose top buckets it did not
    know existed — and report a number that is wrong but perfectly plausible.
    """
    rows = session.execute(
        "SELECT column_name FROM system_schema.columns "
        "WHERE keyspace_name = %s AND table_name = 'rollup_hourly'",
        (CASSANDRA_KEYSPACE,),
    )
    prefix = "lat_le_"
    bounds = sorted(
        int(r.column_name[len(prefix):])
        for r in rows
        if r.column_name.startswith(prefix)
    )
    if not bounds:
        raise RuntimeError(
            "rollup_hourly has no lat_le_* columns — the schema predates the latency "
            "histogram. Re-run infra/cassandra/init.cql."
        )
    return tuple(bounds)


def prepare(session: Session, bounds: Sequence[int]) -> dict[str, PreparedStatement]:
    hist_cols = ", ".join(f"lat_le_{b}" for b in bounds)
    return {
        "rollup": session.prepare(
            "SELECT day, hour, cost_micros, requests, errors, prompt_tokens, "
            f"completion_tokens, lat_count, quality_sum, quality_count, {hist_cols} "
            "FROM rollup_hourly WHERE project_id = ? AND dim = ? AND day IN ?"
        ),
    }


# --------------------------------------------------------------------------- #
# The window
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Window:
    """What one scope did over one window — everything a condition can ask about."""

    cost: float          # USD
    requests: int
    errors: int
    tokens: int
    latency_p95: float   # ms
    # Written by the *eval* worker, onto the same rollup rows (init.cql). Scores ride as
    # score*100 so the counter can stay an integer, exactly as money rides as micros.
    quality_sum: int = 0
    quality_count: int = 0

    @property
    def error_rate(self) -> float:
        return self.errors / self.requests if self.requests else 0.0

    @property
    def quality(self) -> float:
        """The average score, 1..5. Its denominator is quality_count and never `requests`:
        eval *samples*, so most requests in this window were never scored, and dividing by
        them would report a quality of near-zero for a system that is working fine."""
        return self.quality_sum / self.quality_count / 100 if self.quality_count else 0.0


EMPTY_WINDOW = Window(cost=0.0, requests=0, errors=0, tokens=0, latency_p95=0.0)


def percentile(bounds: Sequence[int], hist: Sequence[int], total: int, p: float) -> float:
    """Interpolate a percentile out of the cumulative `le` histogram.

    The mirror of the console's reader in dashboard/lib/cassandra.ts, and it has to
    stay one: a rule that fires on p95 and a chart that shows p95 disagreeing about
    the same window would be worse than having neither.

    `hist[i]` counts the requests at or below bounds[i]. `total` is lat_count — the
    histogram's own denominator, and deliberately not `requests`, which also counts
    rows written before the histogram existed. See init.cql.
    """
    if total <= 0:
        return 0.0

    rank = p * total
    lower_bound = 0.0
    lower_count = 0
    for bound, count in zip(bounds, hist):
        if count >= rank:
            in_bucket = count - lower_count
            if in_bucket <= 0:
                return lower_bound
            return lower_bound + (rank - lower_count) / in_bucket * (bound - lower_bound)
        lower_bound = float(bound)
        lower_count = count

    # Past the last bound there is no top to interpolate against. The last bound is
    # the honest floor: "at least this slow".
    return float(bounds[-1])


def window_days(hours: int, now: datetime) -> tuple[list[date], datetime]:
    """The day partitions a window touches, and the hour it starts at.

    Deliberately the same arithmetic as the console (dashboard/lib/time.ts): the
    rollup is bucketed by hour, so a window starts at the *top* of the hour holding
    now - N hours, and a "1h" rule therefore sees the current partial hour plus the
    one before it. That is a property of hourly buckets rather than a bug, and the
    thing that actually matters is that the rule and the chart someone opens to check
    it agree on the number.
    """
    start_hour = (now - timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)

    days: list[date] = []
    day = start_hour.date()
    while day <= now.date():
        days.append(day)
        day += timedelta(days=1)
    return days, start_hour


def read_window(
    session: Session,
    stmts: dict[str, PreparedStatement],
    bounds: Sequence[int],
    dim: str,
    hours: int,
    now: datetime,
) -> Window:
    """Sum the rollup over a window, for one breakdown axis. One partition per day."""
    days, start_hour = window_days(hours, now)
    rows = session.execute(stmts["rollup"], (PROJECT, dim, days))

    cost_micros = requests = errors = tokens = lat_count = 0
    quality_sum = quality_count = 0
    hist = [0] * len(bounds)

    for row in rows:
        # Cassandra can only narrow to the day here — `day` is in the partition key,
        # `hour` is a clustering column the query does not constrain. So the hour
        # filter happens on this side, exactly as it does in the console.
        day = row.day.date() if hasattr(row.day, "date") else row.day
        hour_ts = datetime(day.year, day.month, day.day, row.hour, tzinfo=timezone.utc)
        if hour_ts < start_hour or hour_ts > now:
            continue

        cost_micros += row.cost_micros or 0
        requests += row.requests or 0
        errors += row.errors or 0
        tokens += (row.prompt_tokens or 0) + (row.completion_tokens or 0)
        lat_count += row.lat_count or 0
        quality_sum += row.quality_sum or 0
        quality_count += row.quality_count or 0
        for i, bound in enumerate(bounds):
            hist[i] += getattr(row, f"lat_le_{bound}") or 0

    return Window(
        cost=cost_micros / 1_000_000,
        requests=requests,
        errors=errors,
        tokens=tokens,
        latency_p95=percentile(bounds, hist, lat_count, 0.95),
        quality_sum=quality_sum,
        quality_count=quality_count,
    )


# --------------------------------------------------------------------------- #
# The budget period — a calendar, not a window
# --------------------------------------------------------------------------- #
def budget_days(period: str, now: datetime) -> list[date]:
    """The UTC day partitions a budget period covers.

    A deliberate mirror of the gateway's own dayKey / daysOfMonth (gateway/src/budget.ts).
    A budget is a *calendar* thing — "80% of today's cap" means all of today, not the last
    N hours — and the alert has to be measuring the same thing the enforcement measures.
    Otherwise "you are at 80% of your budget" would be a sentence about a different budget
    than the one that is about to start refusing calls.
    """
    today = now.date()
    if period == "daily":
        return [today]
    if period == "monthly":
        return [date(today.year, today.month, d) for d in range(1, today.day + 1)]
    raise ValueError(f"unknown budget period: {period!r} (expected one of {', '.join(BUDGET_PERIODS)})")


def read_spend(session: Session, stmts: dict[str, PreparedStatement], dim: str, days: list[date]) -> float:
    """What one scope spent across whole day partitions. No hour filter — see budget_days."""
    rows = session.execute(stmts["rollup"], (PROJECT, dim, days))
    return sum(row.cost_micros or 0 for row in rows) / 1_000_000


def budget_cap(store: Store, key_id: str, period: str) -> float | None:
    """The key's cap for that period, or None if it has none."""
    key = store.api_keys.find_one({"_id": key_id}, {"budget": 1})
    if key is None:
        raise ValueError(f"no such api key: {key_id}")
    budget = key.get("budget") or {}
    return budget.get("daily_usd") if period == "daily" else budget.get("monthly_usd")


# --------------------------------------------------------------------------- #
# The judgment — pure, and that is the point
# --------------------------------------------------------------------------- #
def condition_kind(condition: dict) -> str:
    """Which kind of question this rule is asking. Refuses one it cannot answer.

    Silently treating an unrecognised type as a cost threshold would give someone a rule
    that looks armed on the screen and is watching the wrong thing — or nothing at all.
    """
    kind = condition.get("type") or "metric_threshold"
    if kind not in CONDITIONS:
        raise ValueError(f"unknown condition type: {kind!r} (expected one of {', '.join(CONDITIONS)})")
    return kind


def metric_value(name: str, w: Window) -> float:
    if name == "cost":
        return w.cost
    if name == "tokens":
        return float(w.tokens)
    if name == "latency_p95":
        return w.latency_p95
    if name == "error_rate":
        return w.error_rate
    if name == "request_count":
        return float(w.requests)
    raise ValueError(f"unknown metric: {name!r} (expected one of {', '.join(METRICS)})")


def evaluate_threshold(condition: dict, w: Window) -> tuple[bool, float]:
    """metric_threshold — is the window's number over the line? -> (tripped, that number)

    Pure on purpose. Spec §14 requires the rule judgment to be unit-tested, and a
    function over an already-fetched window is one you can test without standing up
    a database — the same reason the gateway's budgetVerdict is shaped this way.

    Strictly greater, not >=: this condition reads "over X", and a rule that fired the
    instant a counter *touched* its threshold would fire on a 0 threshold with nothing
    spent. (budget_percent goes the other way, and for a good reason — see below.)
    """
    observed = metric_value(condition["metric"], w)
    return observed > float(condition["threshold"]), observed


def evaluate_budget(condition: dict, spent: float, cap: float | None) -> tuple[bool, float]:
    """budget_percent — how much of the cap is gone, and is that enough to speak up?

    `>=`, not `>`, and that is not an inconsistency with the threshold above. The spec says
    "도달" — *reached* — and it is the same comparison the gateway makes when it decides to
    start refusing the call (budgetVerdict). An alert set at 100% that only fired once the
    key had gone strictly *past* its cap would be telling you about a fire you are already
    standing in.

    Returns the percentage rather than the dollars: "87% of the cap" is the sentence someone
    actually wants, and it is the one number that means the same thing whether the cap is $5
    or $5,000.
    """
    if cap is None or cap <= 0:
        # Not a zero. A rule watching a budget that does not exist can never be right, and
        # reporting 0% would say the opposite of "this rule is broken".
        raise ValueError("budget_percent needs a key with a budget set for that period")

    observed = spent / cap * 100.0
    return observed >= float(condition["percent"]), observed


def evaluate_quality(condition: dict, w: Window) -> tuple[bool, float]:
    """quality_drop — has the average score fallen below the line? -> (tripped, that average)

    `<`, and that is the spec's own word: 임계값 *미만*, below. metric_threshold reads "over"
    and uses `>`; budget_percent reads "reached" and uses `>=`. Each condition compares the
    way the sentence it is written in compares.

    Two guards, both about what sampling does to an average:

    A window with *no* scored calls never trips. Its average is not zero — it is unknown —
    and zero is below every threshold anyone would set, so a rule reading "alert me when
    quality drops below 3" would fire continuously on a system where evaluation happens to
    be switched off, or has simply not caught up yet. That is the loudest imaginable way to
    report "no data", and it would train someone to ignore the alert that matters.

    A window with too *few* scores does not trip either. At a 10% sample rate a quiet hour
    might be judged once, and an average of one is not an average. min_samples is how much
    evidence this rule wants before it is willing to wake someone (MIN_QUALITY_SAMPLES by
    default) — the observed value is still returned, so a rule that stayed quiet for lack of
    evidence can still be understood from the logs.
    """
    needed = int(condition.get("min_samples") or MIN_QUALITY_SAMPLES)
    if w.quality_count < needed:
        return False, w.quality
    return w.quality < float(condition["min_score"]), w.quality


# --------------------------------------------------------------------------- #
# keyword_match — the one condition no rollup can answer
# --------------------------------------------------------------------------- #
def prompt_text(doc: dict) -> str:
    """Every message in the request, flattened.

    The gateway stores the whole conversation, and a keyword can be hiding in any turn of
    it — the system prompt included. Searching only the last message would miss exactly the
    case someone writes a keyword rule for.
    """
    messages = (doc.get("request") or {}).get("messages") or []
    return "\n".join(str(m.get("content") or "") for m in messages)


def response_text(doc: dict) -> str:
    return str((doc.get("response") or {}).get("content") or "")


def keyword_hit(condition: dict, prompt: str, answer: str) -> str | None:
    """Where the keyword turned up, or None.

    Case-insensitive substring, deliberately. Someone watching for "password" means the
    word, and a rule that sailed straight past "Password" would be a rule that quietly did
    not work — the worst kind, because it looks armed the entire time it is missing things.
    """
    keyword = str(condition.get("keyword") or "").strip()
    if not keyword:
        raise ValueError("keyword_match has no keyword")

    target = condition.get("matched_in") or "either"
    if target not in KEYWORD_TARGETS:
        raise ValueError(
            f"unknown keyword target: {target!r} (expected one of {', '.join(KEYWORD_TARGETS)})"
        )

    needle = keyword.lower()
    if target in ("prompt", "either") and needle in prompt.lower():
        return "prompt"
    if target in ("response", "either") and needle in answer.lower():
        return "response"
    return None


def trigger_text(firing: dict) -> str:
    """One line for what tripped, in the words a human would use.

    Written once, here, and then stored *on the firing* — so the email, the webhook and the
    console's history all say the same sentence, and the console never has to re-derive it
    in TypeScript out of fields whose meaning changes with the condition type.
    """
    kind = firing.get("condition_type") or "metric_threshold"

    if kind == "budget_percent":
        return (
            f"{firing['observed']:.1f}% of the {firing.get('period')} budget is spent "
            f"(${firing.get('spent', 0):.4g} of ${firing.get('cap', 0):g}) — alerts at "
            f"{firing['threshold']:g}%"
        )
    if kind == "keyword_match":
        return f"{firing.get('keyword')!r} found in the {firing.get('matched_in')}"

    if kind == "quality_drop":
        # The sample size is part of the claim, not a footnote: "quality is 2.4" means
        # something different over 6 scored calls than over 600, and the person reading
        # this at 3am is entitled to know which one it was.
        return (
            f"average quality {firing['observed']:.2f} below {firing['threshold']:g} "
            f"across {firing.get('scored')} scored calls in the last "
            f"{firing.get('window_hours')}h"
        )

    return (
        f"{firing.get('metric')} {firing['observed']:.6g} over {firing['threshold']:g} "
        f"in the last {firing.get('window_hours')}h"
    )


# --------------------------------------------------------------------------- #
# Firing
# --------------------------------------------------------------------------- #
def claim(rules_coll, rule: dict, now: datetime) -> bool:
    """Take the right to fire this rule — or discover the cooldown still holds it.

    The cooldown is not a sleep and not a timestamp in this process's memory. It is a
    conditional update: only the writer whose filter still matched gets a document
    back. So two workers that evaluate the same tripped rule in the same second send
    one email between them, not two, and a restart cannot forget that a rule already
    fired four minutes ago.
    """
    cooldown = int(rule.get("cooldown_seconds") or 0)
    cutoff = now - timedelta(seconds=cooldown)
    claimed = rules_coll.find_one_and_update(
        {
            "_id": rule["_id"],
            "$or": [
                {"last_fired_at": None},
                {"last_fired_at": {"$exists": False}},
                {"last_fired_at": {"$lte": cutoff}},
            ],
        },
        {"$set": {"last_fired_at": now}},
    )
    return claimed is not None


def firing_doc(rule: dict, kind: str, observed: float, now: datetime, **extra) -> dict:
    """What happened, in the shape the console's firing history reads.

    `detail` is the whole point of this being written here rather than assembled by the
    reader. Three condition types answer three different questions, and the fields that
    make one of them legible are meaningless on the others — so the sentence is composed
    once, at the moment it is true, and everything downstream just repeats it.
    """
    condition = rule["condition"]
    firing = {
        "rule_id": rule["_id"],
        "rule_name": rule.get("name"),
        "fired_at": now,
        "scope": rule.get("scope") or "all",
        "condition_type": kind,
        "observed": observed,
        # The number it had to beat. A percentage for budget_percent, a score for
        # quality_drop, a threshold for metric_threshold, and nothing meaningful for
        # keyword_match.
        "threshold": float(
            condition.get("threshold")
            or condition.get("percent")
            or condition.get("min_score")
            or 0
        ),
        "metric": condition.get("metric"),
        "window_hours": int(condition.get("window_hours") or 1),
        **extra,
    }
    firing["detail"] = trigger_text(firing)
    return firing


# --------------------------------------------------------------------------- #
# Actions — the part with side effects
# --------------------------------------------------------------------------- #
def scope_query(scope: str, start: datetime, now: datetime) -> dict:
    """The request documents a scope covers over a window.

    The Mongo mirror of the rollup `dim` the condition was judged against. It has to
    select the same requests the counters counted, or a `tag` action would label a
    different set of calls than the one that tripped the rule.
    """
    query: dict = {"ts": {"$gte": start, "$lte": now}}
    if scope.startswith("model:"):
        query["model"] = scope[len("model:"):]
    elif scope.startswith("key:"):
        query["api_key_id"] = scope[len("key:"):]
    elif scope != "all":
        raise ValueError(f"unknown scope: {scope!r}")
    return query


def email_body(rule: dict, firing: dict) -> str:
    """What the human actually reads.

    It has to answer, without them opening anything: what tripped, on what, by how much —
    and when they will hear about it again. An alert that only says "a rule fired" makes
    them go and look, which is the work the alert was supposed to save.
    """
    lines = [
        f"{rule.get('name') or rule['_id']} fired.",
        "",
        f"  {firing['detail']}",
        "",
        f"  scope      {firing['scope']}",
        f"  fired at   {firing['fired_at'].isoformat()}",
    ]
    # A keyword rule matched one specific call. Name it — the first thing anyone will want
    # is to go and read the thing that tripped it.
    if firing.get("request_id"):
        lines.append(f"  request    {firing['request_id']}")
    lines += ["", f"Silenced for the next {int(rule.get('cooldown_seconds') or 0)}s.", ""]
    return "\n".join(lines)


def act_email(rule: dict, firing: dict, action: dict) -> str:
    to = str(action.get("to") or "").strip()
    if not to:
        raise ValueError("email action has no recipient")

    msg = EmailMessage()
    msg["Subject"] = f"[tollbooth] {rule.get('name') or rule['_id']}"
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg.set_content(email_body(rule, firing))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=ACTION_TIMEOUT) as smtp:
        if SMTP_USER:
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        smtp.send_message(msg)
    return f"sent to {to}"


def webhook_payload(rule: dict, firing: dict) -> dict:
    """One body that Slack, Discord and a plain endpoint can all read.

    Slack renders `text`, Discord renders `content`, and anything bespoke gets the
    structured fields. Sending all three costs nothing and saves a per-vendor template,
    which is the kind of thing that rots.

    The prose comes from the firing's own `detail`, so a webhook and an email about the
    same firing cannot end up describing it differently.
    """
    summary = f"[tollbooth] {rule.get('name') or rule['_id']} on {firing['scope']}: {firing['detail']}"
    payload = {
        "rule_id": rule["_id"],
        "rule_name": rule.get("name"),
        "scope": firing["scope"],
        "condition_type": firing["condition_type"],
        "threshold": firing["threshold"],
        "observed": firing["observed"],
        "detail": firing["detail"],
        "fired_at": firing["fired_at"].isoformat(),
        "text": summary,
        "content": summary,
    }
    # Whatever else this condition had to say about itself. Datetimes never reach here —
    # the only one is fired_at, and it went out as a string above.
    for field in ("metric", "window_hours", "period", "spent", "cap", "keyword", "matched_in", "request_id"):
        if firing.get(field) is not None:
            payload[field] = firing[field]
    return payload


def act_webhook(rule: dict, firing: dict, action: dict) -> str:
    url = str(action.get("url") or "").strip()
    if not url:
        raise ValueError("webhook action has no url")

    req = urlrequest.Request(
        url,
        data=json.dumps(webhook_payload(rule, firing)).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=ACTION_TIMEOUT) as resp:  # noqa: S310 — the URL is the user's own rule
        return f"POST {url} -> {resp.status}"


def tell_gateway_to_forget_its_keys() -> str:
    """Ask the gateway to drop its key cache, so the block just written takes effect now.

    Deliberately returns a note instead of raising. The block *is* the Mongo write —
    that is the durable truth, and the gateway will honour it within 30 seconds no
    matter what happens here. All this decides is whether those 30 seconds happen. So a
    gateway that cannot be reached is worth saying out loud on the firing record, but
    it is not a failed block, and raising would mark the action failed and tell the
    operator the opposite of what is true.
    """
    if not GATEWAY_URL or not GATEWAY_INTERNAL_TOKEN:
        return " (gateway not wired up; the block lands when its key cache expires)"

    # An empty `{}` rather than no body at all: Fastify refuses a POST that carries a
    # Content-Length without a Content-Type (415), and there is nothing to say here —
    # the route takes no arguments, it just forgets everything.
    req = urlrequest.Request(
        f"{GATEWAY_URL.rstrip('/')}/internal/keys/invalidate",
        data=b"{}",
        headers={
            "X-Internal-Token": GATEWAY_INTERNAL_TOKEN,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=ACTION_TIMEOUT):  # noqa: S310 — our own gateway
            return ", gateway cache dropped (effective now)"
    except Exception as exc:  # noqa: BLE001 — the block already landed; this is only its latency
        return f" (gateway not reachable: {exc}; the block lands within 30s regardless)"


def act_block(store: Store, firing: dict) -> str:
    """Flip the key to blocked, then tell the gateway.

    The flip is the whole enforcement: the gateway already refuses blocked keys on
    every chat request, and this writes the same field the console's own Block button
    writes. The telling is only about *when* — see above.
    """
    scope = firing["scope"]
    if not scope.startswith("key:"):
        # 'all' would take the whole gateway down on one bad hour, and a model is not
        # something the gateway can refuse — it authenticates keys, not models.
        raise ValueError(f"block needs a key-scoped rule, got scope {scope!r}")

    key_id = scope[len("key:"):]
    result = store.api_keys.update_one({"_id": key_id}, {"$set": {"status": "blocked"}})
    if result.matched_count == 0:
        raise ValueError(f"no such api key: {key_id}")

    return f"blocked {key_id}{tell_gateway_to_forget_its_keys()}"


def act_tag(store: Store, firing: dict, action: dict, start: datetime, now: datetime) -> str:
    """Label the requests that made up the breach, so the Requests screen can filter
    to exactly them."""
    tag = str(action.get("tag") or "").strip()
    if not tag:
        raise ValueError("tag action has no tag")

    # A keyword rule did not trip on a window — it tripped on one specific call. Tagging
    # the whole hour around it would bury the one request someone actually needs to read.
    if firing.get("request_id"):
        result = store.requests.update_one(
            {"_id": firing["request_id"]}, {"$addToSet": {"tags": tag}}
        )
        if result.matched_count == 0:
            raise ValueError(f"no such request: {firing['request_id']}")
        return f"tagged request {firing['request_id']} as {tag!r}"

    query = scope_query(firing["scope"], start, now)
    ids = [
        doc["_id"]
        for doc in store.requests.find(query, {"_id": 1}).sort("ts", DESCENDING).limit(TAG_LIMIT)
    ]
    if not ids:
        return "no requests in the window to tag"

    # $addToSet on a field no other writer touches. The request document already has
    # two authors — the gateway writes the prompt and response, the ingest worker
    # writes the metrics — and they coexist because neither ever replaces the doc.
    # This is the third, on the same terms.
    result = store.requests.update_many({"_id": {"$in": ids}}, {"$addToSet": {"tags": tag}})
    capped = f" (capped at {TAG_LIMIT})" if len(ids) >= TAG_LIMIT else ""
    return f"tagged {result.modified_count} requests as {tag!r}{capped}"


def run_actions(store: Store, rule: dict, firing: dict, start: datetime, now: datetime) -> list[dict]:
    """Run a rule's actions. Let none of them stop the others.

    They run *after* the cooldown has been claimed, and that ordering is deliberate: a
    failed email is not retried until the cooldown expires. A worker that kept retrying
    a failing webhook every twenty seconds would defeat the one mechanism standing
    between a human and an alert storm — so the failure is recorded on the firing,
    where the console can show it, and left alone.
    """
    results: list[dict] = []

    for action in rule.get("actions") or []:
        kind = action.get("type")
        try:
            if kind == "email":
                detail = act_email(rule, firing, action)
            elif kind == "webhook":
                detail = act_webhook(rule, firing, action)
            elif kind == "block":
                detail = act_block(store, firing)
            elif kind == "tag":
                detail = act_tag(store, firing, action, start, now)
            else:
                raise ValueError(f"unknown action type: {kind!r} (expected one of {', '.join(ACTIONS)})")
        except Exception as exc:  # noqa: BLE001 — one broken action must not silence the rest
            results.append({"type": kind, "ok": False, "detail": str(exc)})
            print(f"rules: {rule['_id']} -> {kind} FAILED: {exc}", file=sys.stderr, flush=True)
            continue

        results.append({"type": kind, "ok": True, "detail": detail})
        print(f"rules: {rule['_id']} -> {kind}: {detail}", flush=True)

    return results


def run_pass(
    session,
    stmts,
    bounds: Sequence[int],
    store: Store,
    scopes: set[str] | None,
) -> int:
    """Evaluate every enabled rule once. `scopes=None` means "all of them".

    Rules on the same (scope, window) share one Cassandra read — several rules watching
    cost, tokens and error rate on the same key is the common case, and it is one
    question to the rollup, not three.
    """
    now = datetime.now(timezone.utc)
    windows: dict[tuple[str, int], Window] = {}
    fired = 0

    for rule in store.rules.find({"enabled": True}):
        scope = rule.get("scope") or "all"
        condition = rule.get("condition") or {}

        try:
            kind = condition_kind(condition)
        except ValueError as exc:
            print(f"rules: skipping {rule['_id']}: {exc}", file=sys.stderr, flush=True)
            continue

        # Keyword rules are answered on the event path, not here. No rollup knows what a
        # response said — see check_keywords.
        if kind == "keyword_match":
            continue

        # quality_drop is exempt from the active-scope filter, and it is the one condition
        # that has to be. The filter rests on an argument that is true of the others and
        # false of this one: a scope that saw no traffic cannot have newly crossed an
        # "over" line, because with no traffic its window only shrinks.
        #
        # A quality window does not work that way. Its evidence is written by the *eval*
        # worker, straight to the rollup, some seconds after the call it describes — by
        # which time this scope may well have gone quiet and be filtered out. And it is a
        # *below* test: as the good hours age out of the window, the average can fall past
        # the line with no new traffic at all. Filtering it would produce a rule that only
        # notices bad quality while traffic keeps arriving, which is not what it promises.
        #
        # The cost of exempting it is one rollup read per quality rule per pass, and the
        # windows cache below means rules sharing a (scope, window) still share that read.
        if kind != "quality_drop" and scopes is not None and scope not in scopes:
            continue

        extra: dict = {}
        try:
            if kind == "budget_percent":
                if not scope.startswith("key:"):
                    # A budget belongs to a key. 'all' has no cap to be a percentage of.
                    raise ValueError(f"budget_percent needs a key-scoped rule, got {scope!r}")
                period = condition.get("period") or "daily"
                key_id = scope[len("key:"):]
                cap = budget_cap(store, key_id, period)
                spent = read_spend(session, stmts, scope, budget_days(period, now))
                tripped, observed = evaluate_budget(condition, spent, cap)
                extra = {"period": period, "spent": spent, "cap": cap}
            elif kind == "quality_drop":
                hours = int(condition.get("window_hours") or 1)
                if (scope, hours) not in windows:
                    windows[(scope, hours)] = read_window(session, stmts, bounds, scope, hours, now)
                window = windows[(scope, hours)]
                tripped, observed = evaluate_quality(condition, window)
                # How much evidence the average rests on. It rides on the firing because the
                # sentence the worker writes says it out loud — see trigger_text.
                extra = {"scored": window.quality_count}
            else:
                hours = int(condition.get("window_hours") or 1)
                if (scope, hours) not in windows:
                    windows[(scope, hours)] = read_window(session, stmts, bounds, scope, hours, now)
                tripped, observed = evaluate_threshold(condition, windows[(scope, hours)])
        except (KeyError, ValueError, TypeError) as exc:
            # A malformed rule is the console's bug, not a reason to stop watching every
            # other rule.
            print(f"rules: skipping {rule['_id']}: {exc}", file=sys.stderr, flush=True)
            continue

        # Claim before acting. The cooldown has to be taken before a single email goes
        # out, or two workers racing on the same tripped rule would both send one.
        if not tripped or not claim(store.rules, rule, now):
            continue

        firing = firing_doc(rule, kind, observed, now, **extra)
        print(f"rules: {rule['_id']} fired on {scope} — {firing['detail']}", flush=True)

        _, start = window_days(firing["window_hours"], now)
        firing["actions"] = run_actions(store, rule, firing, start, now)
        store.firings.insert_one(firing)
        fired += 1

    return fired


def watch_quality(store: Store) -> bool:
    """Is any quality rule enabled? Re-asked once per pass, not once per event.

    It is the one thing that can make a pass worth running with no traffic at all — see
    the note in main() for why quality is the exception to "no traffic, no crossing".
    """
    return store.rules.count_documents({"enabled": True, "condition.type": "quality_drop"}, limit=1) > 0


def check_keywords(store: Store, watchers: list[dict], event: dict) -> int:
    """The one condition that has to look at an actual request.

    No rollup can answer "did this response contain the word 'password'" — the text is not
    in the rollup, and it is not in the event either. The event carries a request_doc_id,
    and the body lives in the Mongo document the gateway wrote at call time. So this is the
    only condition that costs a read per request, which is exactly why it samples.

    Two things it cannot do, both worth knowing rather than discovering:
      - Synthetic loadgen events have no document body, so a keyword rule sees nothing in
        them. It needs real gateway traffic, which is the only traffic that has words in it.
      - The cooldown still applies. A key leaking secrets on a hundred calls produces one
        alert, naming one of them. That is the cooldown working, not the rule missing —
        but the alert names the request so the first click lands on the evidence.
    """
    if not watchers or random.random() >= KEYWORD_SAMPLE_RATE:
        return 0

    dims = set(dims_of(event))
    watching = [r for r in watchers if (r.get("scope") or "all") in dims]
    if not watching:
        return 0

    doc_id = event.get("request_doc_id") or event.get("event_id")
    if not doc_id:
        return 0

    doc = store.requests.find_one({"_id": doc_id}, {"request": 1, "response": 1})
    if not doc:
        return 0  # a synthetic event, or the gateway's write has not landed yet

    prompt, answer = prompt_text(doc), response_text(doc)
    if not prompt and not answer:
        return 0

    now = datetime.now(timezone.utc)
    fired = 0

    for rule in watching:
        try:
            where = keyword_hit(rule["condition"], prompt, answer)
        except (KeyError, ValueError) as exc:
            print(f"rules: skipping {rule['_id']}: {exc}", file=sys.stderr, flush=True)
            continue

        if where is None or not claim(store.rules, rule, now):
            continue

        firing = firing_doc(
            rule, "keyword_match", 1.0, now,
            keyword=str(rule["condition"].get("keyword") or "").strip(),
            matched_in=where,
            request_id=doc_id,
        )
        print(f"rules: {rule['_id']} fired on {firing['scope']} — {firing['detail']}", flush=True)

        firing["actions"] = run_actions(store, rule, firing, now, now)
        store.firings.insert_one(firing)
        fired += 1

    return fired


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def build_consumer() -> Consumer:
    return Consumer({
        "bootstrap.servers": BOOTSTRAP,
        "group.id": GROUP_ID,
        # `latest`, where ingest uses `earliest`. A monitor that boots and replays a
        # week of backlog would raise a week of alarms about a week that is over.
        "auto.offset.reset": "latest",
        "enable.auto.commit": False,
    })


def dims_of(event: dict) -> tuple[str, str, str]:
    """The three rollup axes an event lands on — the same three the ingest worker
    increments, and therefore the three scopes a rule could be watching."""
    return (
        "all",
        f"model:{event.get('model') or 'unknown'}",
        f"key:{event.get('api_key_id') or 'unknown'}",
    )


def main() -> None:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    cluster, session = connect_cassandra()
    bounds = latency_bounds(session)
    stmts = prepare(session, bounds)
    store = connect_mongo()

    consumer = build_consumer()
    consumer.subscribe([TOPIC])
    print(
        f"rules: consuming '{TOPIC}' from {BOOTSTRAP} as group '{GROUP_ID}' -> "
        f"evaluating every {EVAL_SECONDS:g}s against Cassandra "
        f"{CASSANDRA_CONTACT_POINTS}/{CASSANDRA_KEYSPACE}; "
        f"latency ladder {list(bounds)}; mail via {SMTP_HOST}:{SMTP_PORT}; "
        f"keyword sampling {KEYWORD_SAMPLE_RATE:g}",
        flush=True,
    )

    # Scopes that saw a request since the last pass. Nothing else can have crossed an
    # "over" threshold: with no traffic a window only shrinks.
    active: set[str] = set()
    # ...except on the first pass, where we have no idea what happened while we were
    # down, so everything gets checked once.
    check_everything = True
    # The keyword rules, held between passes. They are consulted on *every* event, and
    # asking Mongo which rules exist once per event would cost more than the rule does.
    # Loaded now and refreshed on each pass, so a new keyword rule arms within one
    # EVAL_SECONDS — and one that already exists is watching from the first event, not
    # from the first pass twenty seconds later.
    keyword_rules: list[dict] = list(
        store.rules.find({"enabled": True, "condition.type": "keyword_match"})
    )
    # Is any quality rule watching? If so, a pass is due every EVAL_SECONDS whether or not
    # a single event arrived — and this is the loop's counterpart to the exemption in
    # run_pass, without which that exemption is dead code.
    #
    # The `active` optimisation below skips the whole pass when nothing moved, and for the
    # other conditions that is sound: no traffic, no new crossing. A quality rule breaks
    # both halves of that argument. Its evidence is written to the rollup by the *eval*
    # worker, seconds after the call it describes and long after the event went by; and it
    # tests *below* a line, which an aging window can cross with no traffic at all. Gate it
    # on traffic and it becomes a rule that only notices bad quality while the calls keep
    # coming — which is precisely when nobody is looking.
    watching_quality = watch_quality(store)
    pending = 0
    last_eval = time.monotonic()

    try:
        while _running:
            msg = consumer.poll(1.0)
            if msg is not None:
                if msg.error():
                    if msg.error().code() != KafkaError._PARTITION_EOF:
                        print(f"rules: consumer error: {msg.error()}", file=sys.stderr, flush=True)
                else:
                    try:
                        event = json.loads(msg.value())
                        active.update(dims_of(event))
                        pending += 1
                        # Per-event, because the words are only ever in one request.
                        check_keywords(store, keyword_rules, event)
                    except (ValueError, TypeError) as exc:
                        print(f"rules: skipping bad message: {exc}", file=sys.stderr, flush=True)

            if (time.monotonic() - last_eval) < EVAL_SECONDS:
                continue

            if check_everything or active or watching_quality:
                run_pass(
                    session, stmts, bounds, store,
                    None if check_everything else set(active),
                )
                check_everything = False
                active.clear()

            keyword_rules = list(
                store.rules.find({"enabled": True, "condition.type": "keyword_match"})
            )
            watching_quality = watch_quality(store)

            # Only now: a pass that raised would leave the offsets where they were,
            # and the events that triggered it would be re-read.
            if pending:
                consumer.commit(asynchronous=False)
                pending = 0

            last_eval = time.monotonic()
    finally:
        consumer.close()
        cluster.shutdown()
        store.client.close()
        print("rules: shutting down", flush=True)


if __name__ == "__main__":
    main()
