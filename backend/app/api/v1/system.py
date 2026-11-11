"""System status, reference metadata, API usage / budgets and the STR regulation registry."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import func, select

from app.api.deps import AdminUser, Session
from app.core.config import get_settings
from app.core.errors import NotFoundError
from app.finance.inputs import Assumptions
from app.finance.scoring import COMPONENT_LABELS, ScoreWeights
from app.models.tables import Provider, ProviderApiUsage, StrRegulation
from app.providers.base import PROPERTY_TYPE_LABELS
from app.providers.demo import demo_markets_summary
from app.providers.registry import get_providers
from app.providers.usage import PROVIDER_SPECS, get_usage_tracker
from app.schemas.search import SORT_LABELS
from app.services.property_store import normalize_jurisdiction

router = APIRouter(prefix="/system", tags=["system"])


class ProviderStatus(BaseModel):
    key: str
    name: str
    purpose: str
    configured: bool
    attribution: str | None = None
    note: str | None = None


class SystemStatus(BaseModel):
    data_mode: Literal["demo", "live"]
    demo_notice: str | None
    demo_markets: list[dict[str, str]]
    providers: list[ProviderStatus]
    llm_enabled: bool
    llm_model: str | None
    geocoding_enabled: bool
    str_provider_enabled: bool
    registration_enabled: bool
    freshness: dict[str, float]
    limits: dict[str, float]


@router.get("/status", response_model=SystemStatus)
async def status() -> SystemStatus:
    """What data the app is running on. The UI uses this to label demo data prominently."""
    s = get_settings()
    providers = get_providers()
    demo = providers.is_demo
    return SystemStatus(
        data_mode="demo" if demo else "live",
        demo_notice=(
            "Demo mode: all properties and rents are synthetic sample data — not real listings. "
            "Add a RentCast API key to search live listings."
            if demo
            else None
        ),
        demo_markets=demo_markets_summary() if demo else [],
        providers=[
            ProviderStatus(key="rentcast", name="RentCast", purpose="For-sale listings, rent & value estimates, market statistics, tax records", configured=s.rentcast_api_key is not None, attribution=PROVIDER_SPECS["rentcast"].attribution, note=None if s.rentcast_api_key else "Set RENTCAST_API_KEY to enable live listings"),
            ProviderStatus(key="mapbox", name="Mapbox", purpose="Geocoding for radius and county searches", configured=s.mapbox_access_token is not None, attribution=PROVIDER_SPECS["mapbox"].attribution, note=None if s.mapbox_access_token else "Set MAPBOX_ACCESS_TOKEN; without it radius searches fall back to the named area"),
            ProviderStatus(key="anthropic", name="Anthropic Claude", purpose="AI property analysis and natural-language search", configured=s.llm_enabled, note=None if s.llm_enabled else "Set ANTHROPIC_API_KEY; without it deterministic rule-based summaries and parsing are used"),
        ],
        llm_enabled=s.llm_enabled,
        llm_model=s.llm_model if s.llm_enabled else None,
        geocoding_enabled=providers.geocoder is not None,
        str_provider_enabled=providers.short_term is not None,
        registration_enabled=s.allow_registration,
        freshness={
            "listing_cache_hours": round(s.listing_cache_ttl_seconds / 3600, 1),
            "rent_estimate_days": s.rent_estimate_ttl_days,
            "value_estimate_days": s.value_estimate_ttl_days,
            "str_estimate_days": s.str_estimate_ttl_days,
            "market_stats_days": s.market_stats_ttl_days,
        },
        limits={"max_listings_per_search": s.max_listings_per_search, "rent_avm_top_n": s.rent_avm_top_n, "str_estimate_top_n": s.str_estimate_top_n, "high_yield_threshold_pct": float(s.high_yield_threshold_pct), "below_market_threshold_pct": float(s.below_market_threshold_pct)},
    )


class Meta(BaseModel):
    property_types: dict[str, str]
    sort_options: dict[str, str]
    default_assumptions: dict[str, Any]
    default_weights: dict[str, float]
    weight_labels: dict[str, str]


@router.get("/meta", response_model=Meta)
async def meta() -> Meta:
    """Reference data for building forms: property types, sort options and default assumptions."""
    defaults = Assumptions.model_validate({"acquisition": {"purchase_price": 1}}).model_dump(mode="json")
    defaults["acquisition"].pop("purchase_price")
    return Meta(
        property_types={k: v for k, v in PROPERTY_TYPE_LABELS.items() if k not in ("land", "other")},
        sort_options=SORT_LABELS,
        default_assumptions=defaults,
        default_weights={k: float(v) for k, v in ScoreWeights().model_dump().items()},
        weight_labels=COMPONENT_LABELS,
    )


# --------------------------------------------------------------------------- usage & budgets


class ProviderUsage(BaseModel):
    key: str
    name: str
    kind: str
    enabled: bool
    monthly_request_limit: int | None
    monthly_cost_limit_usd: float | None
    cost_per_request_usd: float
    requests_this_month: int
    estimated_cost_this_month_usd: float
    errors_this_month: int
    request_budget_used_pct: float | None
    cost_budget_used_pct: float | None


class DailyUsage(BaseModel):
    day: date
    provider: str
    requests: int
    errors: int
    cost_usd: float


class RecentError(BaseModel):
    provider: str
    endpoint: str
    status_code: int | None
    error: str | None
    created_at: datetime


class UsageReport(BaseModel):
    month: str
    providers: list[ProviderUsage]
    daily: list[DailyUsage]
    recent_errors: list[RecentError]
    note: str = "Costs are estimates: requests × the configured cost per request. Check your provider invoices for actual charges."


@router.get("/usage", response_model=UsageReport)
async def usage(_: AdminUser, session: Session) -> UsageReport:
    """API requests, errors and estimated cost per provider for the current month (administrators only)."""
    tracker = get_usage_tracker()
    rows = (await session.execute(select(Provider).order_by(Provider.key))).scalars().all()
    providers = []
    for row in rows:
        if row.key == "demo":
            continue
        requests, cost, errors = await tracker.month_to_date(row.key)
        providers.append(
            ProviderUsage(
                key=row.key,
                name=row.name,
                kind=row.kind,
                enabled=row.enabled,
                monthly_request_limit=row.monthly_request_limit,
                monthly_cost_limit_usd=float(row.monthly_cost_limit_usd) if row.monthly_cost_limit_usd is not None else None,
                cost_per_request_usd=float(row.cost_per_request_usd),
                requests_this_month=requests,
                estimated_cost_this_month_usd=float(cost),
                errors_this_month=errors,
                request_budget_used_pct=round(requests / row.monthly_request_limit * 100, 1) if row.monthly_request_limit else None,
                cost_budget_used_pct=round(float(cost / row.monthly_cost_limit_usd * 100), 1) if row.monthly_cost_limit_usd else None,
            )
        )
    since = datetime.now(UTC) - timedelta(days=30)
    day = func.date_trunc("day", ProviderApiUsage.created_at)
    daily_rows = (
        await session.execute(
            select(day, ProviderApiUsage.provider_key, func.count(), func.count().filter(ProviderApiUsage.ok.is_(False)), func.coalesce(func.sum(ProviderApiUsage.cost_usd), 0))
            .where(ProviderApiUsage.created_at >= since)
            .group_by(day, ProviderApiUsage.provider_key)
            .order_by(day)
        )
    ).all()
    errors_rows = (
        await session.execute(select(ProviderApiUsage).where(ProviderApiUsage.ok.is_(False)).order_by(ProviderApiUsage.created_at.desc()).limit(20))
    ).scalars()
    return UsageReport(
        month=datetime.now(UTC).strftime("%Y-%m"),
        providers=providers,
        daily=[DailyUsage(day=d.date(), provider=p, requests=n, errors=e, cost_usd=float(c)) for d, p, n, e, c in daily_rows],
        recent_errors=[RecentError(provider=r.provider_key, endpoint=r.endpoint, status_code=r.status_code, error=r.error, created_at=r.created_at) for r in errors_rows],
    )


class BudgetUpdate(BaseModel):
    enabled: bool | None = None
    monthly_request_limit: int | None = Field(default=None, ge=0, le=10_000_000)
    monthly_cost_limit_usd: Decimal | None = Field(default=None, ge=0, le=1_000_000)
    cost_per_request_usd: Decimal | None = Field(default=None, ge=0, le=1000)


@router.put("/budgets/{provider_key}", response_model=ProviderUsage)
async def update_budget(provider_key: str, body: BudgetUpdate, _: AdminUser, session: Session) -> ProviderUsage:
    """Set a provider's monthly request / cost budget (administrators only).

    Send `null` for a limit to remove it. When a budget is reached, searches return partial results
    with an explanation instead of silently stopping.
    """
    row = await session.get(Provider, provider_key)
    if row is None or provider_key == "demo":
        raise NotFoundError("Unknown provider")
    data = body.model_dump(exclude_unset=True)
    for name, value in data.items():
        if name in ("enabled", "cost_per_request_usd") and value is None:
            continue
        setattr(row, name, value)
    await session.flush()
    get_usage_tracker().invalidate(provider_key)
    requests, cost, errors = await get_usage_tracker().month_to_date(provider_key)
    return ProviderUsage(
        key=row.key, name=row.name, kind=row.kind, enabled=row.enabled, monthly_request_limit=row.monthly_request_limit,
        monthly_cost_limit_usd=float(row.monthly_cost_limit_usd) if row.monthly_cost_limit_usd is not None else None,
        cost_per_request_usd=float(row.cost_per_request_usd), requests_this_month=requests, estimated_cost_this_month_usd=float(cost), errors_this_month=errors,
        request_budget_used_pct=round(requests / row.monthly_request_limit * 100, 1) if row.monthly_request_limit else None,
        cost_budget_used_pct=round(float(cost / row.monthly_cost_limit_usd * 100), 1) if row.monthly_cost_limit_usd else None,
    )


# --------------------------------------------------------------------------- STR regulation registry


class RegulationIn(BaseModel):
    jurisdiction_type: Literal["zip", "city", "county", "state"]
    jurisdiction_key: str = Field(min_length=2, max_length=160, description='"30303", "Atlanta, GA", "Fulton, GA" or "GA"')
    status: Literal["permitted", "restricted", "prohibited"]
    summary: str | None = Field(default=None, max_length=2000)
    max_nights_per_year: int | None = Field(default=None, ge=0, le=365)
    source_url: HttpUrl = Field(description="Link to the ordinance or official page this status was verified against")
    verified_at: date


class RegulationOut(BaseModel):
    id: uuid.UUID
    jurisdiction_type: str
    jurisdiction_key: str
    status: str
    summary: str | None
    max_nights_per_year: int | None
    source_url: str | None
    verified_at: date | None
    updated_at: datetime


def _regulation(row: StrRegulation) -> RegulationOut:
    return RegulationOut(
        id=row.id, jurisdiction_type=row.jurisdiction_type, jurisdiction_key=row.jurisdiction_key, status=row.status, summary=row.summary,
        max_nights_per_year=row.max_nights_per_year, source_url=row.source_url, verified_at=row.verified_at, updated_at=row.updated_at,
    )


@router.get("/str-regulations", response_model=list[RegulationOut])
async def list_regulations(session: Session) -> list[RegulationOut]:
    """Verified short-term rental rules by jurisdiction. Anything not listed is treated as unknown."""
    rows = (await session.execute(select(StrRegulation).order_by(StrRegulation.jurisdiction_type, StrRegulation.jurisdiction_key))).scalars()
    return [_regulation(row) for row in rows]


@router.put("/str-regulations", response_model=RegulationOut)
async def upsert_regulation(body: RegulationIn, admin: AdminUser, session: Session) -> RegulationOut:
    """Record a verified STR rule (administrators only). A source link and verification date are required."""
    key = normalize_jurisdiction(body.jurisdiction_type, body.jurisdiction_key)
    row = (
        await session.execute(select(StrRegulation).where(StrRegulation.jurisdiction_type == body.jurisdiction_type, StrRegulation.jurisdiction_key == key))
    ).scalar_one_or_none()
    if row is None:
        row = StrRegulation(jurisdiction_type=body.jurisdiction_type, jurisdiction_key=key)
        session.add(row)
    row.status = body.status
    row.summary = body.summary
    row.max_nights_per_year = body.max_nights_per_year
    row.source_url = str(body.source_url)
    row.verified_at = body.verified_at
    row.verified_by = admin.id
    await session.flush()
    await session.refresh(row)
    return _regulation(row)


@router.delete("/str-regulations/{regulation_id}", status_code=204)
async def delete_regulation(regulation_id: uuid.UUID, _: AdminUser, session: Session) -> None:
    row = await session.get(StrRegulation, regulation_id)
    if row is None:
        raise NotFoundError("Regulation not found")
    await session.delete(row)
