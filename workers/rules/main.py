"""rules worker — decide when something is worth telling someone about, then tell them.

A rule is a condition, a scope, a cooldown and a set of actions. This worker consumes
llm.events on its own Kafka consumer group and, on a timer, evaluates every enabled
rule against the hourly rollup — then emails, posts a webhook, blocks the key or tags
the requests that made up the breach.

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

# The metrics a threshold can be written against (spec §4 group C).
METRICS = ("cost", "tokens", "latency_p95", "error_rate", "request_count")
ACTIONS = ("email", "webhook", "block", "tag")

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


def firing_doc(rule: dict, observed: float, now: datetime) -> dict:
    """What happened, in the shape the console's firing history reads."""
    condition = rule["condition"]
    return {
        "rule_id": rule["_id"],
        "rule_name": rule.get("name"),
        "fired_at": now,
        "scope": rule.get("scope") or "all",
        "metric": condition.get("metric"),
        "window_hours": int(condition.get("window_hours") or 1),
        "threshold": float(condition["threshold"]),
        "observed": observed,
    }


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

    It has to answer, without them opening anything: what tripped, on what, by how
    much, over what window — and when they will hear about it again. An alert that
    only says "a rule fired" makes them go and look, which is the work the alert was
    supposed to save.
    """
    return (
        f"{rule.get('name') or rule['_id']} fired.\n"
        f"\n"
        f"  scope      {firing['scope']}\n"
        f"  metric     {firing['metric']}\n"
        f"  window     last {firing['window_hours']}h\n"
        f"  threshold  {firing['threshold']:g}\n"
        f"  observed   {firing['observed']:.6g}\n"
        f"  fired at   {firing['fired_at'].isoformat()}\n"
        f"\n"
        f"Silenced for the next {int(rule.get('cooldown_seconds') or 0)}s.\n"
    )


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
    structured fields. Sending all three costs nothing and saves a per-vendor
    template, which is the kind of thing that rots.
    """
    summary = (
        f"[tollbooth] {rule.get('name') or rule['_id']}: {firing['metric']} "
        f"{firing['observed']:.6g} over {firing['threshold']:g} on {firing['scope']} "
        f"({firing['window_hours']}h)"
    )
    return {
        "rule_id": rule["_id"],
        "rule_name": rule.get("name"),
        "scope": firing["scope"],
        "metric": firing["metric"],
        "window_hours": firing["window_hours"],
        "threshold": firing["threshold"],
        "observed": firing["observed"],
        "fired_at": firing["fired_at"].isoformat(),
        "text": summary,
        "content": summary,
    }


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
            # A malformed rule is the console's bug, not a reason to stop watching every
            # other rule.
            print(f"rules: skipping {rule['_id']}: {exc}", file=sys.stderr, flush=True)
            continue

        # Claim before acting. The cooldown has to be taken before a single email goes
        # out, or two workers racing on the same tripped rule would both send one.
        if not tripped or not claim(store.rules, rule, now):
            continue

        print(
            f"rules: {rule['_id']} fired — {condition.get('metric')}={observed:.4g} "
            f"over {condition.get('threshold')} on {scope} ({hours}h)",
            flush=True,
        )

        firing = firing_doc(rule, observed, now)
        _, start = window_days(firing["window_hours"], now)
        firing["actions"] = run_actions(store, rule, firing, start, now)
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
        f"latency ladder {list(bounds)}; mail via {SMTP_HOST}:{SMTP_PORT}",
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
                    session, stmts, bounds, store,
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
        store.client.close()
        print("rules: shutting down", flush=True)


if __name__ == "__main__":
    main()
