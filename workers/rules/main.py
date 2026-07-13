"""rules worker — decide when something is worth telling someone about.

A rule is a condition, a scope, a cooldown and (from the next increment) a set of
actions. This worker consumes llm.events on its own Kafka consumer group and, on a
timer, evaluates every enabled rule against the hourly rollup.

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
import signal
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Sequence

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

# The metrics a threshold can be written against (spec §4 group C).
METRICS = ("cost", "tokens", "latency_p95", "error_rate", "request_count")

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


def connect_mongo():
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]
    rules, firings = db["rules"], db["rule_firings"]
    # Idempotent, and created here rather than in a seed script for the same reason
    # every other index in this project is (see gateway/src/keys.ts): the service
    # that depends on an index is the service that should guarantee it.
    rules.create_index("enabled")
    firings.create_index([("fired_at", DESCENDING)])
    firings.create_index("rule_id")
    return client, rules, firings


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
            f"completion_tokens, lat_count, {hist_cols} FROM rollup_hourly "
            "WHERE project_id = ? AND dim = ? AND day IN ?"
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

    @property
    def error_rate(self) -> float:
        return self.errors / self.requests if self.requests else 0.0


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
        for i, bound in enumerate(bounds):
            hist[i] += getattr(row, f"lat_le_{bound}") or 0

    return Window(
        cost=cost_micros / 1_000_000,
        requests=requests,
        errors=errors,
        tokens=tokens,
        latency_p95=percentile(bounds, hist, lat_count, 0.95),
    )


# --------------------------------------------------------------------------- #
# The judgment — pure, and that is the point
# --------------------------------------------------------------------------- #
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


def evaluate(condition: dict, w: Window) -> tuple[bool, float]:
    """Does this condition trip against this window? -> (tripped, the value that decided it)

    Pure on purpose. Spec §14 requires the rule judgment to be unit-tested, and a
    function over an already-fetched window is one you can test without standing up
    a database — the same reason the gateway's budgetVerdict is shaped this way.

    Strictly greater, not >=: every condition here reads "over X", and a rule that
    fires the instant a counter *touches* its threshold would fire on a $0 budget
    with $0 spent. (P5's quality-drop condition is a "below", and will need a
    direction on the condition. It does not exist yet, so neither does the field.)
    """
    kind = condition.get("type") or "metric_threshold"
    if kind != "metric_threshold":
        raise ValueError(f"unknown condition type: {kind!r}")

    observed = metric_value(condition["metric"], w)
    return observed > float(condition["threshold"]), observed


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


def record_firing(firings_coll, rule: dict, observed: float, now: datetime) -> None:
    """Write down that this happened. The console's firing history reads this."""
    condition = rule["condition"]
    firings_coll.insert_one({
        "rule_id": rule["_id"],
        "rule_name": rule.get("name"),
        "fired_at": now,
        "scope": rule.get("scope") or "all",
        "metric": condition.get("metric"),
        "window_hours": int(condition.get("window_hours") or 1),
        "threshold": float(condition["threshold"]),
        "observed": observed,
        # Filled in once the actions land — an empty list here means the rule tripped
        # and nobody was told, which is exactly what this increment does.
        "actions": [],
    })


def run_pass(
    session,
    stmts,
    bounds: Sequence[int],
    rules_coll,
    firings_coll,
    scopes: set[str] | None,
) -> int:
    """Evaluate every enabled rule once. `scopes=None` means "all of them".

    Rules on the same (scope, window) share one Cassandra read — several rules
    watching cost, tokens and error rate on the same key is the common case, and it
    is one question to the rollup, not three.
    """
    now = datetime.now(timezone.utc)
    windows: dict[tuple[str, int], Window] = {}
    fired = 0

    for rule in rules_coll.find({"enabled": True}):
        scope = rule.get("scope") or "all"
        if scopes is not None and scope not in scopes:
            continue

        condition = rule.get("condition") or {}
        hours = int(condition.get("window_hours") or 1)

        key = (scope, hours)
        if key not in windows:
            windows[key] = read_window(session, stmts, bounds, scope, hours, now)

        try:
            tripped, observed = evaluate(condition, windows[key])
        except (KeyError, ValueError, TypeError) as exc:
            # A malformed rule is the console's bug, not a reason to stop watching
            # every other rule.
            print(f"rules: skipping {rule['_id']}: {exc}", file=sys.stderr, flush=True)
            continue

        if not tripped or not claim(rules_coll, rule, now):
            continue

        record_firing(firings_coll, rule, observed, now)
        fired += 1
        print(
            f"rules: {rule['_id']} fired — {condition.get('metric')}={observed:.4g} "
            f"over {condition.get('threshold')} on {scope} ({hours}h)",
            flush=True,
        )

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
    mongo_client, rules_coll, firings_coll = connect_mongo()

    consumer = build_consumer()
    consumer.subscribe([TOPIC])
    print(
        f"rules: consuming '{TOPIC}' from {BOOTSTRAP} as group '{GROUP_ID}' -> "
        f"evaluating every {EVAL_SECONDS:g}s against Cassandra "
        f"{CASSANDRA_CONTACT_POINTS}/{CASSANDRA_KEYSPACE}; "
        f"latency ladder {list(bounds)}",
        flush=True,
    )

    # Scopes that saw a request since the last pass. Nothing else can have crossed an
    # "over" threshold: with no traffic a window only shrinks.
    active: set[str] = set()
    # ...except on the first pass, where we have no idea what happened while we were
    # down, so everything gets checked once.
    check_everything = True
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
                        active.update(dims_of(json.loads(msg.value())))
                        pending += 1
                    except (ValueError, TypeError) as exc:
                        print(f"rules: skipping bad message: {exc}", file=sys.stderr, flush=True)

            if (time.monotonic() - last_eval) < EVAL_SECONDS:
                continue

            if check_everything or active:
                run_pass(
                    session, stmts, bounds, rules_coll, firings_coll,
                    None if check_everything else set(active),
                )
                check_everything = False
                active.clear()

            # Only now: a pass that raised would leave the offsets where they were,
            # and the events that triggered it would be re-read.
            if pending:
                consumer.commit(asynchronous=False)
                pending = 0

            last_eval = time.monotonic()
    finally:
        consumer.close()
        cluster.shutdown()
        mongo_client.close()
        print("rules: shutting down", flush=True)


if __name__ == "__main__":
    main()
