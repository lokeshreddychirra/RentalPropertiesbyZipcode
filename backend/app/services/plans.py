"""Subscription plans and usage quotas.

Two things cost money with the listing provider, so those are what plans meter:

* **ZIP searches** — distinct ZIP codes a user searches in a period. Re-running a ZIP already
  searched in the period is free (it is served from cache).
* **Property reports** — properties whose property-level estimates (rent, value, tax record) had
  to be bought from the provider. Opening a property whose data is already cached is free.

The free plan's allowance is for the lifetime of the account; paid plans reset every calendar
month (UTC). Administrators are unlimited. Quotas only apply in live data mode.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, PlanLimitError
from app.models.tables import PlanConfig, User, UserUsage
from app.schemas.search import SearchFilters

PLAN_KEYS = ("free", "pro", "premium")
ZIP_SEARCH = "zip_search"
PROPERTY_REPORT = "property_report"
# Every search covers exactly one ZIP code, for every plan (keeps provider costs predictable).
ZIPS_PER_SEARCH = 1


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    price_usd: Decimal
    zip_searches: int | None  # None = unlimited
    property_reports: int | None
    zips_per_search: int
    monthly: bool  # False = lifetime allowance
    features: tuple[str, ...]


# Administrator overrides from the plan_configs table, refreshed at most every few seconds.
_overrides: dict[str, dict] = {}
_loaded_at = 0.0
_REFRESH_SECONDS = 15


async def refresh(session: AsyncSession, *, force: bool = False) -> None:
    global _overrides, _loaded_at
    if not force and time.monotonic() - _loaded_at < _REFRESH_SECONDS:
        return
    rows = (await session.execute(select(PlanConfig))).scalars().all()
    _overrides = {
        row.key: {"price_usd": row.price_usd, "zip_searches": row.zip_searches, "property_reports": row.property_reports}
        for row in rows
    }
    _loaded_at = time.monotonic()


def default_plans() -> dict[str, Plan]:
    """Plans as configured by environment variables (before administrator overrides)."""
    s = get_settings()
    return {
        "free": Plan(
            "free", "Free", Decimal("0"), s.plan_free_zip_searches, s.plan_free_property_reports, ZIPS_PER_SEARCH, False,
            ("Full analysis of every listing in the ZIP", "Cash flow, cap rate and yield for every home", "Save properties"),
        ),
        "pro": Plan(
            "pro", "Pro", s.plan_pro_price_usd, s.plan_pro_zip_searches, s.plan_pro_property_reports, ZIPS_PER_SEARCH, True,
            ("Everything in Free", "Saved searches", "CSV and PDF export", "Property comparison"),
        ),
        "premium": Plan(
            "premium", "Premium", s.plan_premium_price_usd, s.plan_premium_zip_searches, s.plan_premium_property_reports, ZIPS_PER_SEARCH, True,
            ("Everything in Pro", "Most ZIP codes and property reports", "Saved-search alerts", "Priority support"),
        ),
    }


def plans() -> dict[str, Plan]:
    """Current plans: environment defaults with the administrator's overrides applied."""
    out = {}
    for key, plan in default_plans().items():
        override = _overrides.get(key)
        if override:
            plan = replace(plan, **override)
        out[key] = plan
    return out


def plan_for(user: User) -> Plan:
    return plans().get(user.plan or "free", plans()["free"])


def is_unlimited(user: User) -> bool:
    return user.role == "admin"


def quotas_apply() -> bool:
    return get_settings().effective_data_mode != "demo"


def current_period(plan: Plan, now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y-%m") if plan.monthly else "lifetime"


async def used_items(session: AsyncSession, user: User, kind: str, period: str) -> set[str]:
    rows = await session.execute(select(UserUsage.item).where(UserUsage.user_id == user.id, UserUsage.kind == kind, UserUsage.period == period))
    return set(rows.scalars())


async def usage_count(session: AsyncSession, user: User, kind: str, period: str) -> int:
    return (
        await session.execute(select(func.count()).select_from(UserUsage).where(UserUsage.user_id == user.id, UserUsage.kind == kind, UserUsage.period == period))
    ).scalar_one()


async def record(session: AsyncSession, user: User, kind: str, items: list[str], period: str) -> None:
    for item in items:
        stmt = insert(UserUsage).values(user_id=user.id, kind=kind, item=item[:64], period=period)
        await session.execute(stmt.on_conflict_do_nothing(index_elements=["user_id", "kind", "item", "period"]))
    await session.commit()


def _limit_error(plan: Plan, what: str, used: int, limit: int) -> PlanLimitError:
    window = "this month" if plan.monthly else "on the free plan"
    upgrade = "Upgrade to Premium for more." if plan.key == "pro" else "Upgrade to Pro or Premium to continue." if plan.key == "free" else "Your allowance resets on the 1st of next month."
    return PlanLimitError(
        f"You have used {used} of {limit} {what} {window}. {upgrade}",
        details={"plan": plan.key, "kind": what, "used": used, "limit": limit},
    )


def validate_zip_only(filters: SearchFilters, user: User) -> list[str]:
    """Searches are by ZIP code only (keeps provider costs predictable). Returns the ZIP codes."""
    if filters.cities or filters.state or filters.county or filters.radius_miles or filters.polygon:
        raise AppError("Search by ZIP code — city, state, county, radius and map-area searches are not available yet.", code="zip_only", status_code=422)
    if not filters.zip_codes:
        raise AppError("Enter at least one 5-digit ZIP code.", code="validation_error", status_code=422)
    if len(filters.zip_codes) > ZIPS_PER_SEARCH:
        raise AppError("Search one ZIP code at a time.", code="one_zip", status_code=422)
    return list(filters.zip_codes)


async def authorize_search(session: AsyncSession, user: User, filters: SearchFilters) -> None:
    """Enforce the ZIP-only rule and the plan's ZIP allowance, recording newly used ZIP codes."""
    await refresh(session)
    zips = validate_zip_only(filters, user)
    if is_unlimited(user) or not quotas_apply():
        return
    plan = plan_for(user)
    period = current_period(plan)
    used = await used_items(session, user, ZIP_SEARCH, period)
    new = [z for z in zips if z not in used]
    if plan.zip_searches is not None and len(used) + len(new) > plan.zip_searches:
        raise _limit_error(plan, "ZIP code searches", len(used), plan.zip_searches)
    if new:
        await record(session, user, ZIP_SEARCH, new, period)


async def authorize_property_report(session: AsyncSession, user: User | None, property_id: str) -> None:
    """Called before buying property-level data. Raises when the user may not; records it otherwise."""
    if not quotas_apply():
        return
    if user is None:
        raise PlanLimitError("Create a free account to get property-level estimates.", details={"plan": None, "kind": "property reports", "used": 0, "limit": 0})
    if is_unlimited(user):
        return
    await refresh(session)
    plan = plan_for(user)
    period = current_period(plan)
    used = await used_items(session, user, PROPERTY_REPORT, period)
    if property_id in used:
        return
    if plan.property_reports is not None and len(used) >= plan.property_reports:
        raise _limit_error(plan, "property reports", len(used), plan.property_reports)
    await record(session, user, PROPERTY_REPORT, [property_id], period)


async def account_summary(session: AsyncSession, user: User) -> dict:
    await refresh(session)
    plan = plan_for(user)
    period = current_period(plan)
    unlimited = is_unlimited(user)
    return {
        "plan": plan.key,
        "plan_name": "Administrator" if unlimited else plan.name,
        "unlimited": unlimited,
        "period": period,
        "monthly": plan.monthly,
        "zip_searches_used": await usage_count(session, user, ZIP_SEARCH, period),
        "zip_searches_limit": None if unlimited else plan.zip_searches,
        "property_reports_used": await usage_count(session, user, PROPERTY_REPORT, period),
        "property_reports_limit": None if unlimited else plan.property_reports,
        "zips_per_search": ZIPS_PER_SEARCH,
        "searched_zips": sorted(await used_items(session, user, ZIP_SEARCH, period)),
        "quotas_apply": quotas_apply(),
        "plan_status": user.plan_status,
        "plan_renews_at": user.plan_renews_at,
        "can_manage_billing": bool(user.stripe_customer_id and get_settings().stripe_secret_key),
    }
