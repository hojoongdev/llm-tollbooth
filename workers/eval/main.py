"""eval worker — sample calls, score their quality, record it.

Two stages, one process, a Kafka topic between them (spec §3.2 step 6, §4 group D):

  sampler  Consume llm.events. Decide *cheaply* which successful calls to score —
           a sample rate, plus optional model/key filters — and push a small task to
           llm.eval.tasks. No LLM call, no Mongo read; it only has to keep up with
           the stream.
  scorer   Consume llm.eval.tasks. Read the call's prompt and answer, ask a judge LLM
           to score it 1..5 on relevance / hallucination risk / tone, embed the scores
           on the request document, and add them to the quality rollup. One LLM call
           per task — slow, and deliberately downstream of the topic.

Why a topic between two halves of one worker:
  Scoring is the slow part (an LLM call each) and sampling is the fast part. Putting
  llm.eval.tasks between them means a burst of scoring backs up *there* — on its own
  topic, at its own offsets — instead of stalling the consumer that reads llm.events.
  The sampler keeps pace with the event stream no matter how far behind the scorer
  falls, and the scorer can be scaled or restarted without the sampler noticing. It is
  still one deployable process (spec §5 lists three workers, not four); the two loops
  are threads sharing nothing but the shutdown flag.

Why sample at all (spec §4 group D): whole-corpus evaluation costs one judge call per
request. Sampling bounds that. The default is 10%.

The judge is the gateway itself. The worker calls /v1/chat/completions like any other
client, with its own API key, so evaluation works with zero external keys (the mock
answers) and a real low-cost judge model is a one-line change. Its own judge calls are
tagged so the sampler never scores them — otherwise scoring would generate traffic that
got scored, forever. With the mock (no real judge), the prose it returns has no scores
to parse, so the worker falls back to a deterministic stand-in derived from the answer:
varied enough to demo quality trends and trip a quality_drop rule, and honestly not a
real quality signal. Point EVAL_MODEL at a real model for that.

Correctness: like the ingest worker, the quality rollup is Cassandra counters, so a
redelivered task can double-count a bucket slightly. The embed on the request is a $set
and idempotent. Same trade the ingest worker makes — cheap reads, rare small drift.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import signal
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib import request as urlrequest

from cassandra.cluster import Cluster, Session
from cassandra.query import PreparedStatement
from confluent_kafka import Consumer, KafkaError, Producer
from pymongo import MongoClient

# --- Kafka ---
EVENTS_TOPIC = os.environ.get("KAFKA_TOPIC", "llm.events")
TASKS_TOPIC = os.environ.get("KAFKA_EVAL_TOPIC", "llm.eval.tasks")
BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092")
SAMPLER_GROUP = os.environ.get("EVAL_SAMPLER_GROUP", "eval-sampler")
SCORER_GROUP = os.environ.get("EVAL_SCORER_GROUP", "eval-scorer")

# --- Cassandra ---
CASSANDRA_CONTACT_POINTS = os.environ.get("CASSANDRA_CONTACT_POINTS", "localhost").split(",")
CASSANDRA_PORT = int(os.environ.get("CASSANDRA_PORT", "9042"))
CASSANDRA_KEYSPACE = os.environ.get("CASSANDRA_KEYSPACE", "tollbooth")

# --- MongoDB ---
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.environ.get("MONGO_DB", "tollbooth")

PROJECT = os.environ.get("PROJECT_ID", "default")

# --- Sampling (seeds the editable settings doc; the console can change these live) ---
SAMPLE_RATE = float(os.environ.get("EVAL_SAMPLE_RATE", "0.1"))
EVAL_MODEL = os.environ.get("EVAL_MODEL", "gpt-4o-mini")
EVAL_MODELS = [m.strip() for m in os.environ.get("EVAL_MODELS", "").split(",") if m.strip()]
EVAL_KEYS = [k.strip() for k in os.environ.get("EVAL_KEYS", "").split(",") if k.strip()]
# How often each loop re-reads the settings doc, so a console change arms quickly.
SETTINGS_REFRESH = float(os.environ.get("EVAL_SETTINGS_REFRESH_SECONDS", "10"))

# --- The judge (the gateway) ---
GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:8080").rstrip("/")
# The worker's own key. Provisioned in Mongo on boot (ensure_eval_key), so the gateway
# authenticates it like any issued key — and its traffic is attributed to key_eval,
# apart from real callers'.
EVAL_KEY_ID = "key_eval"
EVAL_API_KEY = os.environ.get("EVAL_API_KEY", "tb_eval_worker_key")
# Every judge call carries this. The sampler skips anything wearing it, so evaluation
# never evaluates itself into a loop.
EVAL_TAG = os.environ.get("EVAL_TAG", "__eval__")
EVAL_TIMEOUT = float(os.environ.get("EVAL_TIMEOUT", "30"))

_running = True


def _stop(*_args) -> None:
    global _running
    _running = False


# --------------------------------------------------------------------------- #
# The judgment — pure, so §14 can test it without a database or a broker
# --------------------------------------------------------------------------- #
JUDGE_SYSTEM = (
    "You are a strict evaluator of an AI assistant's answer. Score the answer on three "
    "axes, each an integer from 1 to 5:\n"
    "  relevance: did it actually address the user's question? (5 fully, 1 not at all)\n"
    "  hallucination_risk: how likely is it to contain made-up or unsupported claims? "
    "(5 very likely, 1 none)\n"
    "  tone: is the tone appropriate and professional? (5 excellent, 1 poor)\n"
    'Respond with ONLY a JSON object: {"relevance":N,"hallucination_risk":N,"tone":N,'
    '"reason":"<one short sentence>"}'
)


def judge_messages(prompt: str, answer: str) -> list[dict]:
    """The chat sent to the judge: the rubric, then the call it is grading."""
    return [
        {"role": "system", "content": JUDGE_SYSTEM},
        {
            "role": "user",
            "content": f"USER PROMPT:\n{prompt}\n\nASSISTANT ANSWER:\n{answer}",
        },
    ]


def clamp_score(value) -> int:
    """A score is an integer 1..5. Anything a model returns outside that is coerced in,
    rather than rejected — a 7 is a strong signal, a 0 a weak one."""
    return max(1, min(5, round(float(value))))


def parse_scores(text: str | None) -> dict | None:
    """Pull the score object out of the judge's reply, or None if it isn't there.

    A judge may wrap its JSON in prose, so we take the outermost {...}. Missing any of
    the three axes means this wasn't a score at all (the mock's prose lands here), and
    the caller falls back to the heuristic.
    """
    if not text:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    try:
        scores = {
            "relevance": clamp_score(obj["relevance"]),
            "hallucination_risk": clamp_score(obj["hallucination_risk"]),
            "tone": clamp_score(obj["tone"]),
        }
    except (KeyError, TypeError, ValueError):
        return None
    scores["reason"] = str(obj.get("reason") or "").strip()[:280]
    return scores


def heuristic_scores(answer: str) -> dict:
    """A deterministic stand-in for when no judge model returned structured output.

    Not a real quality signal — it is a hash of the actual answer, so it is at least
    real arithmetic over the real text (the same principle as the mock provider), and it
    varies answer to answer, which is what lets the Quality screen show a spread and a
    quality_drop rule ever trip. A real EVAL_MODEL replaces this entirely.
    """
    h = int(hashlib.sha256((answer or "").encode()).hexdigest(), 16)
    return {
        "relevance": 2 + (h % 4),  # 2..5
        "hallucination_risk": 1 + ((h >> 8) % 4),  # 1..4
        "tone": 3 + ((h >> 16) % 3),  # 3..5
        "reason": "heuristic (no judge model returned structured output)",
    }


def overall_score(scores: dict) -> float:
    """One number for the rollup and for quality_drop, on a 1..5 higher-is-better scale.

    hallucination_risk is inverted (6 - risk) because there high *is* bad, so a risky
    answer pulls the overall down instead of up. Averaged with the two where high is
    good, the result stays in 1..5.
    """
    good = scores["relevance"] + scores["tone"] + (6 - scores["hallucination_risk"])
    return round(good / 3.0, 2)


def flatten_prompt(doc: dict) -> str:
    messages = (doc.get("request") or {}).get("messages") or []
    return "\n".join(str(m.get("content") or "") for m in messages)


def dims_of(model: str, api_key_id: str) -> tuple[str, str, str]:
    """The three rollup axes a call lands on — the same three the ingest worker writes,
    so a quality score lands on the very rows the other metrics already occupy."""
    return ("all", f"model:{model or 'unknown'}", f"key:{api_key_id or 'unknown'}")


def _parse_ts(raw: str | None) -> datetime:
    if raw:
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def should_sample(event: dict, settings: dict, roll: float) -> bool:
    """Whether this event is worth a scoring task. Pure: (event, settings, dice) -> bool.

    Only successful calls carry an answer worth judging; a blocked or errored one has
    nothing to grade. The worker's own judge calls are skipped by tag *and* by key, so
    evaluation can never feed itself.
    """
    if not settings.get("enabled", True):
        return False
    if (event.get("status") or "") != "success":
        return False
    if (event.get("feature_tag") or "") == EVAL_TAG:
        return False
    if (event.get("api_key_id") or "") == EVAL_KEY_ID:
        return False
    models = settings.get("models") or []
    if models and (event.get("model") or "") not in models:
        return False
    keys = settings.get("keys") or []
    if keys and (event.get("api_key_id") or "") not in keys:
        return False
    return roll < float(settings.get("sample_rate", SAMPLE_RATE))


# --------------------------------------------------------------------------- #
# Connections + boot
# --------------------------------------------------------------------------- #
def connect_cassandra() -> tuple[Cluster, Session]:
    last_err: Exception | None = None
    for attempt in range(30):
        try:
            cluster = Cluster(CASSANDRA_CONTACT_POINTS, port=CASSANDRA_PORT)
            session = cluster.connect(CASSANDRA_KEYSPACE)
            return cluster, session
        except Exception as exc:  # noqa: BLE001 — surface any driver/connection error and retry
            last_err = exc
            print(f"eval: waiting for Cassandra ({attempt + 1}/30): {exc}", flush=True)
            time.sleep(2)
    raise RuntimeError(f"could not connect to Cassandra: {last_err}")


@dataclass
class Store:
    client: MongoClient
    requests: object
    api_keys: object
    settings: object


def connect_mongo() -> Store:
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]
    return Store(
        client=client,
        requests=db["requests"],
        api_keys=db["api_keys"],
        settings=db["settings"],
    )


def prepare(session: Session) -> dict[str, PreparedStatement]:
    return {
        "quality": session.prepare(
            "UPDATE rollup_hourly SET quality_sum = quality_sum + ?, "
            "quality_count = quality_count + ? "
            "WHERE project_id = ? AND dim = ? AND day = ? AND hour = ?"
        ),
    }


def ensure_eval_key(store: Store) -> None:
    """Provision the worker's own API key, the same way the gateway provisions its
    default one. The gateway authenticates by hash, so it accepts key_eval on its next
    lookup with no coordination — and eval's traffic is attributable to key_eval."""
    store.api_keys.update_one(
        {"_id": EVAL_KEY_ID},
        {
            "$set": {
                "key_hash": hashlib.sha256(EVAL_API_KEY.encode()).hexdigest(),
                "key_prefix": EVAL_API_KEY[:12],
                "status": "active",
            },
            "$setOnInsert": {
                "name": "eval worker",
                "project_id": PROJECT,
                "created_at": datetime.now(timezone.utc),
            },
        },
        upsert=True,
    )


def seed_settings(store: Store) -> None:
    """Write the editable settings doc if it isn't there, so the console's Settings
    screen has something to show and change. $setOnInsert: never clobber a value the
    operator has since edited."""
    store.settings.update_one(
        {"_id": "eval"},
        {
            "$setOnInsert": {
                "enabled": True,
                "sample_rate": SAMPLE_RATE,
                "eval_model": EVAL_MODEL,
                "models": EVAL_MODELS,
                "keys": EVAL_KEYS,
            }
        },
        upsert=True,
    )


def load_settings(store: Store) -> dict:
    doc = store.settings.find_one({"_id": "eval"}) or {}
    return {
        "enabled": doc.get("enabled", True),
        "sample_rate": doc.get("sample_rate", SAMPLE_RATE),
        "eval_model": doc.get("eval_model") or EVAL_MODEL,
        "models": doc.get("models") or EVAL_MODELS,
        "keys": doc.get("keys") or EVAL_KEYS,
    }


# --------------------------------------------------------------------------- #
# Scoring one call (the scorer's per-task work)
# --------------------------------------------------------------------------- #
def call_judge(model: str, prompt: str, answer: str) -> str:
    """Ask the gateway to grade one answer, and hand back the judge's raw reply.

    It is an ordinary chat call through the gateway — tagged, so the sampler ignores the
    traffic it creates. Raises on any transport failure; the caller treats that as "no
    structured score" and falls back to the heuristic.
    """
    payload = {
        "model": model,
        "messages": judge_messages(prompt, answer),
        "temperature": 0,
        "max_tokens": 200,
        "feature_tag": EVAL_TAG,
    }
    req = urlrequest.Request(
        f"{GATEWAY_URL}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {EVAL_API_KEY}",
            "X-Tollbooth-Tag": EVAL_TAG,
        },
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=EVAL_TIMEOUT) as resp:  # noqa: S310 — our own gateway
        body = json.loads(resp.read())
    return body["choices"][0]["message"]["content"]


def score_one(session: Session, stmts: dict, store: Store, model: str, task: dict) -> bool:
    """Score one sampled call: read it, judge it, embed the scores, add to the rollup.

    Returns False (a skip, not a failure) when there is nothing to grade — a synthetic
    event with no body, or a document whose bodies the gateway has not written yet.
    """
    doc_id = task.get("request_doc_id") or task.get("event_id")
    if not doc_id:
        return False

    doc = store.requests.find_one({"_id": doc_id}, {"request": 1, "response": 1})
    answer = ((doc or {}).get("response") or {}).get("content") or ""
    if not doc or not answer:
        return False

    prompt = flatten_prompt(doc)

    scores = None
    try:
        scores = parse_scores(call_judge(model, prompt, answer))
    except Exception as exc:  # noqa: BLE001 — any judge failure degrades to the heuristic
        print(f"eval: judge call failed for {doc_id}: {exc}", file=sys.stderr, flush=True)
    if scores is None:
        scores = heuristic_scores(answer)

    overall = overall_score(scores)
    embed = {**scores, "overall": overall, "model": model, "scored_at": datetime.now(timezone.utc)}
    store.requests.update_one({"_id": doc_id}, {"$set": {"eval": embed}})

    day = _parse_ts(task.get("ts"))
    q = round(overall * 100)
    for dim in dims_of(task.get("model") or "", task.get("api_key_id") or ""):
        session.execute(stmts["quality"], (q, 1, PROJECT, dim, day.date(), day.hour))

    print(f"eval: scored {doc_id} -> {overall} ({scores['reason']})", flush=True)
    return True


# --------------------------------------------------------------------------- #
# The two loops
# --------------------------------------------------------------------------- #
def build_consumer(group: str, offset_reset: str) -> Consumer:
    return Consumer({
        "bootstrap.servers": BOOTSTRAP,
        "group.id": group,
        "auto.offset.reset": offset_reset,
        "enable.auto.commit": False,
    })


def sampler_loop(store: Store) -> None:
    """Consume llm.events, and for the sampled ones push a task to llm.eval.tasks.

    `latest`, not `earliest`: on a cold start there is no value in scoring a backlog of
    calls whose moment has passed. Offsets commit on a timer, after the producer has
    been flushed — so a task is durably on its topic before the event that made it is
    marked read (at-least-once).
    """
    consumer = build_consumer(SAMPLER_GROUP, "latest")
    consumer.subscribe([EVENTS_TOPIC])
    producer = Producer({"bootstrap.servers": BOOTSTRAP})

    settings = load_settings(store)
    last_settings = last_commit = time.monotonic()
    read = queued = 0
    print(f"eval[sampler]: {EVENTS_TOPIC} -> {TASKS_TOPIC}, rate {settings['sample_rate']}", flush=True)

    try:
        while _running:
            now = time.monotonic()
            if now - last_settings >= SETTINGS_REFRESH:
                settings = load_settings(store)
                last_settings = now

            msg = consumer.poll(1.0)
            producer.poll(0)  # let delivery callbacks run
            if msg is not None and not msg.error():
                read += 1
                try:
                    event = json.loads(msg.value())
                    if should_sample(event, settings, random.random()):
                        task = {
                            "event_id": event.get("event_id"),
                            "request_doc_id": event.get("request_doc_id") or event.get("event_id"),
                            "project_id": event.get("project_id") or PROJECT,
                            "api_key_id": event.get("api_key_id"),
                            "model": event.get("model"),
                            "ts": event.get("ts"),
                        }
                        producer.produce(TASKS_TOPIC, key=str(task["event_id"]), value=json.dumps(task).encode())
                        queued += 1
                except (ValueError, TypeError) as exc:
                    print(f"eval[sampler]: skipping bad message: {exc}", file=sys.stderr, flush=True)
            elif msg is not None and msg.error().code() != KafkaError._PARTITION_EOF:
                print(f"eval[sampler]: consumer error: {msg.error()}", file=sys.stderr, flush=True)

            # Commit what has been *read*, not just what was sampled — and only after the
            # tasks it produced are durably on their topic (at-least-once, the same shape
            # the ingest worker uses).
            #
            # Committing only when something was sampled would be the subtle bug: at a
            # 10% rate most windows queue nothing, so the read offset would sit still
            # while thousands of events went by. A restart would then resume from there,
            # re-read all of them, and re-sample ~10% of calls that were already scored —
            # every one of those a duplicate judge call and a double-counted quality
            # counter. Advancing the offset over events we deliberately skipped is the
            # whole point: we are done with them.
            if read and (now - last_commit) >= 2.0:
                producer.flush(5)
                consumer.commit(asynchronous=False)
                if queued:
                    print(f"eval[sampler]: queued {queued}/{read} for scoring", flush=True)
                last_commit = now
                read = queued = 0
    finally:
        producer.flush(5)
        if read:
            consumer.commit(asynchronous=False)
        consumer.close()
        print("eval[sampler]: stopped", flush=True)


def scorer_loop(session: Session, stmts: dict, store: Store) -> None:
    """Consume llm.eval.tasks, score each, commit after each.

    `earliest`: a task that was queued is a call someone chose to evaluate, so the
    backlog is worth draining rather than dropping. One judge call per task makes this
    the slow half — which is exactly why it is on its own topic and offsets.
    """
    consumer = build_consumer(SCORER_GROUP, "earliest")
    consumer.subscribe([TASKS_TOPIC])

    settings = load_settings(store)
    last_settings = time.monotonic()
    print(f"eval[scorer]: {TASKS_TOPIC}, judge model {settings['eval_model']}", flush=True)

    try:
        while _running:
            now = time.monotonic()
            if now - last_settings >= SETTINGS_REFRESH:
                settings = load_settings(store)
                last_settings = now

            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print(f"eval[scorer]: consumer error: {msg.error()}", file=sys.stderr, flush=True)
                continue
            try:
                task = json.loads(msg.value())
                score_one(session, stmts, store, settings["eval_model"], task)
            except (ValueError, TypeError) as exc:
                print(f"eval[scorer]: skipping bad task: {exc}", file=sys.stderr, flush=True)
            # Committed even on a skip: a task with nothing to grade will never have
            # anything to grade, so re-reading it forever helps no one.
            consumer.commit(asynchronous=False)
    finally:
        consumer.close()
        print("eval[scorer]: stopped", flush=True)


def main() -> None:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    cluster, session = connect_cassandra()
    stmts = prepare(session)
    store = connect_mongo()
    ensure_eval_key(store)
    seed_settings(store)

    print(
        f"eval: judge via {GATEWAY_URL} as {EVAL_KEY_ID}; sampling seeds rate "
        f"{SAMPLE_RATE}, model {EVAL_MODEL}",
        flush=True,
    )

    # Two loops, two consumer groups, one process. They share only _running.
    sampler = threading.Thread(target=sampler_loop, args=(store,), name="sampler")
    scorer = threading.Thread(target=scorer_loop, args=(session, stmts, store), name="scorer")
    sampler.start()
    scorer.start()

    try:
        while _running and (sampler.is_alive() or scorer.is_alive()):
            time.sleep(0.5)
    finally:
        _stop()
        sampler.join(10)
        scorer.join(10)
        cluster.shutdown()
        store.client.close()
        print("eval: shutting down", flush=True)


if __name__ == "__main__":
    main()
