"""Synthetic LLM event generation.

Produces events shaped like the ones the real gateway will publish (see the
event schema in docs/spec.md 7.1), so the observability pipeline can be built
and load-tested before the gateway exists.
"""

from __future__ import annotations

import random
import uuid
from datetime import datetime, timezone

# A small catalogue of models with rough per-million-token prices (USD). Only
# used here to make the synthetic cost numbers plausible; the real pricing table
# lives in MongoDB later.
_MODELS = [
    # (provider, model, input_per_mtok, output_per_mtok, weight)
    ("openai", "gpt-4o", 2.50, 10.00, 5),
    ("openai", "gpt-4o-mini", 0.15, 0.60, 8),
    ("anthropic", "claude-3-5-sonnet", 3.00, 15.00, 4),
    ("anthropic", "claude-3-5-haiku", 0.80, 4.00, 6),
    ("selfhost", "llama-3.1-8b", 0.00, 0.00, 3),
]

_FEATURE_TAGS = ["checkout-bot", "support-agent", "summarizer", "search-rerank"]

_ERROR_TYPES = ["upstream_timeout", "rate_limited", "provider_error"]


def pick_model() -> tuple[str, str, float, float]:
    """Draw a model from the weighted catalogue — shared with gateway mode, so
    both modes produce the same traffic mix."""
    weights = [m[4] for m in _MODELS]
    provider, model, in_price, out_price, _ = random.choices(_MODELS, weights=weights)[0]
    return provider, model, in_price, out_price


def make_event(
    project_id: str = "default",
    api_key_id: str = "key_loadgen",
    error_rate: float = 0.0,
) -> dict:
    """Build one synthetic event. `error_rate` is the probability (0..1) that
    this event represents a failed call."""
    provider, model, in_price, out_price = pick_model()

    is_error = random.random() < error_rate

    prompt_tokens = random.randint(50, 2000)
    completion_tokens = 0 if is_error else random.randint(20, 800)
    cost_usd = round(
        prompt_tokens / 1_000_000 * in_price
        + completion_tokens / 1_000_000 * out_price,
        6,
    )

    latency_ms = random.randint(2000, 8000) if is_error else random.randint(200, 3000)

    return {
        "event_id": str(uuid.uuid4()),
        "ts": datetime.now(timezone.utc).isoformat(),
        "project_id": project_id,
        "api_key_id": api_key_id,
        "provider": provider,
        "model": model,
        "endpoint": "/v1/chat/completions",
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "cost_usd": cost_usd,
        "latency_ms": latency_ms,
        "ttfb_ms": None if is_error else random.randint(100, 600),
        "status": "error" if is_error else "success",
        "cache_hit": False,
        "error_type": random.choice(_ERROR_TYPES) if is_error else None,
        "request_doc_id": None,
        "feature_tag": random.choice(_FEATURE_TAGS),
    }
