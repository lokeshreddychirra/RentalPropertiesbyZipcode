"""LLM access (Anthropic Claude) with structured output.

The LLM is used for two things only — turning a natural-language request into
validated search filters, and explaining already-calculated results. It never
produces authoritative numbers: callers validate its output against schemas and
against the deterministic engine's figures.

The model, effort level and budget are configurable (``LLM_MODEL``,
``LLM_EFFORT``, …). When no key is configured the callers fall back to
deterministic rule-based implementations.
"""

from __future__ import annotations

import logging
import time
from typing import TypeVar

import anthropic
from pydantic import BaseModel

from app.core.config import get_settings
from app.providers.base import BudgetExceeded
from app.providers.usage import get_usage_tracker

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)
PROVIDER_KEY = "anthropic"
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMUnavailable(Exception):
    """The LLM could not be used for this request (not configured, over budget, refused, or failed)."""


_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    settings = get_settings()
    if not settings.llm_enabled:
        raise LLMUnavailable("No LLM is configured")
    if _client is None:
        assert settings.anthropic_api_key is not None
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key.get_secret_value(), timeout=settings.llm_timeout_seconds, max_retries=2)
    return _client


async def generate_structured(*, system: str, user: str, schema: type[T], purpose: str) -> T:
    """Ask the model for a response matching ``schema``. Raises LLMUnavailable on any failure."""
    settings = get_settings()
    client = _get_client()
    tracker = get_usage_tracker()
    try:
        await tracker.check_budget(PROVIDER_KEY)
    except BudgetExceeded as exc:
        raise LLMUnavailable(f"LLM budget reached ({exc.message})") from exc

    started = time.monotonic()
    status: int | None = None
    error: str | None = None
    try:
        common = dict(
            model=settings.llm_model,
            max_tokens=settings.llm_max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": settings.llm_effort},
            output_format=schema,
        )
        if settings.llm_refusal_fallback:
            # Server-side refusal fallback: if the primary model declines, the API
            # re-runs the request on a fallback model inside the same call.
            response = await client.beta.messages.parse(betas=[FALLBACK_BETA], fallbacks="default", **common)  # type: ignore[arg-type]
        else:
            response = await client.messages.parse(**common)  # type: ignore[arg-type]
        status = 200
        if response.stop_reason == "refusal":
            raise LLMUnavailable("The model declined this request")
        if response.stop_reason == "max_tokens" or response.parsed_output is None:
            raise LLMUnavailable("The model returned an incomplete response")
        return response.parsed_output
    except LLMUnavailable as exc:
        error = str(exc)
        raise
    except anthropic.RateLimitError as exc:
        status, error = 429, "rate limited"
        raise LLMUnavailable("The LLM provider is rate limiting requests") from exc
    except anthropic.APIStatusError as exc:
        status, error = exc.status_code, f"HTTP {exc.status_code}"
        logger.warning("LLM request for %s failed with HTTP %s", purpose, exc.status_code)
        raise LLMUnavailable("The LLM provider returned an error") from exc
    except anthropic.APIConnectionError as exc:
        error = "connection error"
        raise LLMUnavailable("Could not reach the LLM provider") from exc
    except Exception as exc:  # schema/validation problems in the SDK's parser
        error = type(exc).__name__
        logger.warning("LLM response for %s could not be parsed: %s", purpose, type(exc).__name__)
        raise LLMUnavailable("The LLM response could not be validated") from exc
    finally:
        await tracker.record(
            PROVIDER_KEY,
            f"messages/{purpose}",
            ok=error is None,
            status_code=status,
            duration_ms=int((time.monotonic() - started) * 1000),
            billable=status == 200,
            error=error,
        )
