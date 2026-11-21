"""API usage accounting and budget enforcement.

* Monthly request and cost counters live in Redis (fast, atomic).
* Every call is also appended to ``provider_api_usage`` for audit / reporting.
* Budgets are stored on the ``providers`` table (editable from Settings) and
  fall back to environment defaults.

``check_budget`` is called *before* a paid request; when the budget is used up it
raises :class:`BudgetExceeded`, which the search pipeline surfaces to the user as
a partial result instead of silently stopping.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select

from app.core.config import Settings, get_settings
from app.core.db import session_scope
from app.core.redis import get_redis
from app.models.tables import Provider, ProviderApiUsage

from .base import BudgetExceeded

logger = logging.getLogger(__name__)

MICRO = Decimal("1000000")


@dataclass(frozen=True)
class Budget:
    enabled: bool
    monthly_request_limit: int | None
    monthly_cost_limit_usd: Decimal | None
    cost_per_request_usd: Decimal


@dataclass(frozen=True)
class ProviderSpec:
    key: str
    name: str
    kind: str
    attribution: str | None
    terms_url: str | None


PROVIDER_SPECS: dict[str, ProviderSpec] = {
    "rentcast": ProviderSpec("rentcast", "RentCast", "listings", "Listing and rent data provided by RentCast", "https://www.rentcast.io/terms"),
    "airdna": ProviderSpec("airdna", "AirDNA", "str", "Short-term rental analytics provided by AirDNA", "https://www.airdna.co/terms-of-service"),
    "mapbox": ProviderSpec("mapbox", "Mapbox", "geocoding", "© Mapbox", "https://www.mapbox.com/legal/tos"),
    "anthropic": ProviderSpec("anthropic", "Anthropic (Claude)", "llm", None, "https://www.anthropic.com/legal/commercial-terms"),
    "demo": ProviderSpec("demo", "Demo dataset", "demo", "Synthetic sample data — not real listings", None),
}


def default_budget(key: str, settings: Settings | None = None) -> Budget:
    s = settings or get_settings()
    if key == "rentcast":
        return Budget(True, s.rentcast_monthly_request_budget, s.rentcast_monthly_cost_budget_usd, s.rentcast_cost_per_request_usd)
    if key == "airdna":
        return Budget(True, s.airdna_monthly_request_budget, s.airdna_monthly_cost_budget_usd, s.airdna_cost_per_request_usd)
    if key == "mapbox":
        return Budget(True, s.mapbox_monthly_request_budget, s.mapbox_monthly_cost_budget_usd, s.mapbox_cost_per_request_usd)
    if key == "anthropic":
        return Budget(True, s.llm_monthly_request_budget, s.llm_monthly_cost_budget_usd, s.llm_cost_per_request_usd)
    return Budget(True, None, None, Decimal("0"))


def _month(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y-%m")


def _keys(provider: str, month: str | None = None) -> tuple[str, str, str]:
    base = f"usage:{provider}:{month or _month()}"
    return f"{base}:requests", f"{base}:cost_micro", f"{base}:errors"


class UsageTracker:
    def __init__(self) -> None:
        self._budget_cache: dict[str, tuple[float, Budget]] = {}

    async def budget(self, provider: str) -> Budget:
        cached = self._budget_cache.get(provider)
        if cached and time.monotonic() - cached[0] < 30:
            return cached[1]
        budget = default_budget(provider)
        try:
            async with session_scope() as session:
                row = (await session.execute(select(Provider).where(Provider.key == provider))).scalar_one_or_none()
            if row is not None:
                budget = Budget(row.enabled, row.monthly_request_limit, row.monthly_cost_limit_usd, row.cost_per_request_usd)
        except Exception:  # pragma: no cover - never block a request on budget lookup failures
            logger.exception("Could not load budget for %s; using defaults", provider)
        self._budget_cache[provider] = (time.monotonic(), budget)
        return budget

    def invalidate(self, provider: str | None = None) -> None:
        if provider is None:
            self._budget_cache.clear()
        else:
            self._budget_cache.pop(provider, None)

    async def month_to_date(self, provider: str) -> tuple[int, Decimal, int]:
        """(requests, cost in USD, errors) for the current calendar month (UTC)."""
        requests_key, cost_key, errors_key = _keys(provider)
        requests, cost, errors = await get_redis().mget(requests_key, cost_key, errors_key)
        return int(requests or 0), Decimal(cost or 0) / MICRO, int(errors or 0)

    async def remaining_requests(self, provider: str) -> int | None:
        """How many more requests fit in this month's budget (None = unlimited)."""
        budget = await self.budget(provider)
        if not budget.enabled:
            return 0
        used, cost, _ = await self.month_to_date(provider)
        remaining: int | None = None
        if budget.monthly_request_limit is not None:
            remaining = max(budget.monthly_request_limit - used, 0)
        if budget.monthly_cost_limit_usd is not None and budget.cost_per_request_usd > 0:
            by_cost = int(max(budget.monthly_cost_limit_usd - cost, Decimal("0")) / budget.cost_per_request_usd)
            remaining = by_cost if remaining is None else min(remaining, by_cost)
        return remaining

    async def check_budget(self, provider: str) -> Budget:
        budget = await self.budget(provider)
        if not budget.enabled:
            raise BudgetExceeded(provider, "provider is disabled in Settings")
        used, cost, _ = await self.month_to_date(provider)
        if budget.monthly_request_limit is not None and used >= budget.monthly_request_limit:
            raise BudgetExceeded(provider, f"monthly request budget of {budget.monthly_request_limit} reached")
        if budget.monthly_cost_limit_usd is not None and cost + budget.cost_per_request_usd > budget.monthly_cost_limit_usd:
            raise BudgetExceeded(provider, f"monthly cost budget of ${budget.monthly_cost_limit_usd} reached")
        return budget

    async def record(
        self,
        provider: str,
        endpoint: str,
        *,
        ok: bool,
        status_code: int | None,
        duration_ms: int | None,
        billable: bool,
        error: str | None = None,
    ) -> None:
        budget = await self.budget(provider)
        cost = budget.cost_per_request_usd if billable else Decimal("0")
        requests_key, cost_key, errors_key = _keys(provider)
        pipe = get_redis().pipeline()
        ttl = 60 * 60 * 24 * 70
        pipe.incr(requests_key)
        pipe.expire(requests_key, ttl)
        if cost:
            pipe.incrby(cost_key, int(cost * MICRO))
            pipe.expire(cost_key, ttl)
        if not ok:
            pipe.incr(errors_key)
            pipe.expire(errors_key, ttl)
        try:
            await pipe.execute()
            async with session_scope() as session:
                session.add(
                    ProviderApiUsage(
                        provider_key=provider,
                        endpoint=endpoint[:120],
                        status_code=status_code,
                        ok=ok,
                        cost_usd=cost,
                        duration_ms=duration_ms,
                        error=(error or None) and error[:500],
                    )
                )
        except Exception:  # pragma: no cover - accounting must never break the request
            logger.exception("Failed to record API usage for %s", provider)


_tracker: UsageTracker | None = None


def get_usage_tracker() -> UsageTracker:
    global _tracker
    if _tracker is None:
        _tracker = UsageTracker()
    return _tracker


async def ensure_providers_seeded() -> None:
    """Insert provider rows (with env-default budgets) if they do not exist yet."""
    async with session_scope() as session:
        existing = set((await session.execute(select(Provider.key))).scalars())
        for key, spec in PROVIDER_SPECS.items():
            if key in existing:
                continue
            budget = default_budget(key)
            session.add(
                Provider(
                    key=key,
                    name=spec.name,
                    kind=spec.kind,
                    attribution=spec.attribution,
                    terms_url=spec.terms_url,
                    enabled=True,
                    monthly_request_limit=budget.monthly_request_limit,
                    monthly_cost_limit_usd=budget.monthly_cost_limit_usd,
                    cost_per_request_usd=budget.cost_per_request_usd,
                )
            )
