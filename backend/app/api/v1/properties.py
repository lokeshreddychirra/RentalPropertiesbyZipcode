"""Property search (synchronous convenience endpoint), details and on-demand estimates."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OptionalUser, Session, rate_limit
from app.api.v1.searches import parse_bbox, parse_polygon
from app.core.config import get_settings
from app.core.db import session_scope
from app.core.errors import AppError, NotFoundError, PlanLimitError, UpstreamError
from app.models.tables import (
    FavoriteProperty,
    Property,
    PropertyListing,
    RentEstimate,
    ShortTermRentalEstimate,
    ValueEstimate,
)
from app.providers.base import BudgetExceeded, PropertyType, ProviderError
from app.providers.registry import get_providers
from app.providers.usage import PROVIDER_SPECS
from app.schemas.property import (
    ComparableOut,
    ImageOut,
    PriceEventOut,
    PropertyDetail,
    RentEstimateOut,
    SourceOut,
    StrEstimateOut,
    ValueEstimateOut,
)
from app.schemas.search import SearchFilters, SearchResults, SearchRunRequest, SortKey
from app.services import plans, property_store
from app.services import search as search_service

router = APIRouter(prefix="/properties", tags=["properties"])


@router.get("/search", response_model=SearchResults, dependencies=[rate_limit("search", 40, 60)])
async def search_properties(
    user: CurrentUser,
    session: Session,
    zip_codes: Annotated[list[str] | None, Query(description="One or more 5-digit ZIP codes")] = None,
    cities: Annotated[list[str] | None, Query(description='One or more cities as "City, ST"')] = None,
    state: str | None = None,
    county: str | None = None,
    radius_miles: Annotated[float | None, Query(gt=0, le=100)] = None,
    polygon: Annotated[str | None, Query(description="Search area: lng,lat;lng,lat;…")] = None,
    min_price: Decimal | None = None,
    max_price: Decimal | None = None,
    min_gross_yield: Decimal | None = None,
    min_net_yield: Decimal | None = None,
    min_cap_rate: Decimal | None = None,
    min_cash_on_cash: Decimal | None = None,
    min_cash_flow: Decimal | None = None,
    min_beds: int | None = None,
    max_beds: int | None = None,
    property_types: Annotated[list[PropertyType] | None, Query()] = None,
    max_hoa: Decimal | None = None,
    max_days_on_market: int | None = None,
    min_year_built: int | None = None,
    max_year_built: int | None = None,
    strategy: Annotated[str, Query(pattern="^(ltr|str|both)$")] = "both",
    sort: SortKey = "score",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 24,
    bbox: str | None = None,
) -> SearchResults:
    """Search, analyse and rank properties in one blocking call.

    Runs the same pipeline as `POST /searches/run` and waits for it to finish, which suits scripts and
    small areas. Interactive clients should use the job endpoints to show progress on large searches.
    Check `job.partial` / `job.partial_reasons`: results are never silently truncated.
    """
    try:
        filters = SearchFilters(
            zip_codes=zip_codes or [], cities=cities or [], state=state, county=county, radius_miles=radius_miles, polygon=parse_polygon(polygon),
            min_price=min_price, max_price=max_price, min_gross_yield=min_gross_yield, min_net_yield=min_net_yield, min_cap_rate=min_cap_rate,
            min_cash_on_cash=min_cash_on_cash, min_cash_flow=min_cash_flow, min_beds=min_beds, max_beds=max_beds, property_types=property_types or [],
            max_hoa=max_hoa, max_days_on_market=max_days_on_market, min_year_built=min_year_built, max_year_built=max_year_built, strategy=strategy,  # type: ignore[arg-type]
        )
    except ValueError as exc:
        errors = getattr(exc, "errors", lambda: [])()
        fields = [{"field": ".".join(str(p) for p in e["loc"]), "message": e["msg"].removeprefix("Value error, ")} for e in errors]
        raise AppError("Invalid search filters", code="validation_error", status_code=422, details={"fields": fields}) from exc

    await plans.authorize_search(session, user, filters)
    job, needs_run = await search_service.create_job(SearchRunRequest(filters=filters))
    if needs_run:
        await search_service.run_search_job(job.id)
    else:
        for _ in range(240):  # an identical search is already running elsewhere: wait for it
            current = await search_service.load_job(job.id)
            if current is None or current.status in ("completed", "failed"):
                break
            import asyncio

            await asyncio.sleep(0.5)
    job = await search_service.load_job(job.id)  # type: ignore[assignment]
    if job is None or job.status == "failed":
        raise UpstreamError(job.error if job and job.error else "The search could not be completed")
    cards = await search_service.load_cards(job.id)
    if job.status != "completed" or cards is None:
        raise AppError("The search is still running — poll /searches/jobs/{id}", code="search_not_ready", status_code=409, details={"job_id": job.id})
    return search_service.page_results(job, cards, sort=sort, page=page, page_size=page_size, bbox=parse_bbox(bbox))


async def _require_context(session: Session, property_id: uuid.UUID):
    ctx = await property_store.load_context(session, property_id)
    if ctx is None:
        raise NotFoundError("Property not found")
    return ctx


@router.get("/{property_id}", response_model=PropertyDetail)
async def get_property(property_id: uuid.UUID, session: Session, user: OptionalUser) -> PropertyDetail:
    ctx = await _require_context(session, property_id)
    prop = (
        await session.execute(
            select(Property)
            .where(Property.id == property_id)
            .options(selectinload(Property.listing).selectinload(PropertyListing.sources), selectinload(Property.images), selectinload(Property.price_history))
        )
    ).scalar_one()
    listing = prop.listing
    favorite = False
    if user is not None:
        favorite = (
            await session.execute(select(FavoriteProperty.id).where(FavoriteProperty.user_id == user.id, FavoriteProperty.property_id == property_id))
        ).first() is not None
    provider_keys = {s.provider_key for s in listing.sources} if listing else set()
    return PropertyDetail(
        context=ctx,
        description=listing.description if listing else None,
        lot_size_sqft=prop.lot_size_sqft,
        listing_type=listing.listing_type if listing else None,
        mls_name=listing.mls_name if listing else None,
        mls_number=listing.mls_number if listing else None,
        agent_name=listing.agent_name if listing else None,
        office_name=listing.office_name if listing else None,
        address_line2=prop.address_line2,
        images=[ImageOut(url=i.url, attribution=i.attribution) for i in prop.images],
        price_history=[PriceEventOut(event_date=e.event_date, event_type=e.event_type, price=e.price, source=property_store.provider_name(e.provider_key)) for e in prop.price_history],
        sources=[
            SourceOut(provider=property_store.provider_name(s.provider_key) or s.provider_key, provider_listing_id=s.provider_listing_id, price=s.price, status=s.status, url=s.source_url, fetched_at=s.fetched_at)
            for s in (listing.sources if listing else [])
        ],
        attribution=[spec.attribution for key, spec in PROVIDER_SPECS.items() if key in provider_keys and spec.attribution],
        is_favorite=favorite,
    )


def _comp(row, *, rental: bool) -> ComparableOut:
    return ComparableOut(
        formatted_address=row.formatted_address,
        latitude=float(row.latitude) if row.latitude is not None else None,
        longitude=float(row.longitude) if row.longitude is not None else None,
        price=row.rent if rental else row.price,
        bedrooms=row.bedrooms,
        bathrooms=row.bathrooms,
        square_feet=row.square_feet,
        property_type=row.property_type,
        year_built=None if rental else row.year_built,
        distance_miles=row.distance_miles,
        days_old=row.days_old,
        similarity=row.similarity,
        listed_date=row.listed_date,
    )


def _provider_failure(exc: ProviderError) -> str:
    if isinstance(exc, BudgetExceeded):
        return f"The {exc.provider} API budget is used up ({exc.message}). An administrator can raise it in Settings."
    return f"The provider could not return an estimate ({exc.message})."


@router.get("/{property_id}/rent-estimate", response_model=RentEstimateOut)
async def rent_estimate(
    property_id: uuid.UUID,
    session: Session,
    user: OptionalUser,
    fetch: Annotated[bool, Query(description="Request a property-level estimate from the provider if none is cached (may be billable)")] = False,
    refresh: Annotated[bool, Query(description="Force a new provider request even if a fresh estimate is cached")] = False,
) -> RentEstimateOut:
    """Long-term rent estimate with the comparable rentals it is based on, and data freshness."""
    ctx = await _require_context(session, property_id)
    settings = get_settings()
    providers = get_providers()
    cutoff = datetime.now(UTC) - timedelta(days=settings.rent_estimate_ttl_days)

    async def stored() -> RentEstimate | None:
        return (
            await session.execute(
                select(RentEstimate)
                .where(RentEstimate.property_id == property_id, RentEstimate.level == "property", RentEstimate.fetched_at >= cutoff)
                .options(selectinload(RentEstimate.comparables))
                .order_by(RentEstimate.fetched_at.desc())
            )
        ).scalars().first()

    refresh = refresh and bool(user and plans.is_unlimited(user))  # forced re-purchase: administrators only
    row = None if refresh else await stored()
    fetched_now = False
    failure: str | None = None
    record = None
    if row is None and (fetch or refresh) and providers.rent is not None:
        try:
            await plans.authorize_property_report(session, user, str(property_id))
            record = await providers.rent.rent_estimate(property_store.subject_for(ctx))
        except PlanLimitError as exc:
            failure = exc.message
        except ProviderError as exc:
            record, failure = None, _provider_failure(exc)
        if record is not None:
            async with session_scope() as write:
                await property_store.save_rent_estimate(write, property_id, record)
            session.expire_all()
            row = await stored()
            fetched_now = True
        elif failure is None:
            failure = "The provider has no reliable rent estimate for this address."

    if row is not None:
        return RentEstimateOut(
            available=True, provider=property_store.provider_name(row.provider_key), fetched_at=row.fetched_at, fetched_now=fetched_now, is_demo=ctx.is_demo,
            level="property", rent=row.rent, rent_low=row.rent_low, rent_high=row.rent_high, annual_gross=row.rent * 12, comp_count=row.comp_count,
            comparables=[_comp(c, rental=True) for c in row.comparables],
        )
    if ctx.rent is not None:  # ZIP-level fallback from the search screening stage
        return RentEstimateOut(
            available=True, provider=ctx.rent.provider, fetched_at=ctx.rent.fetched_at, is_demo=ctx.is_demo, level="market_zip", rent=ctx.rent.rent,
            rent_low=ctx.rent.rent_low, rent_high=ctx.rent.rent_high, annual_gross=ctx.rent.rent * 12, market_sample=ctx.rent.market_sample,
            reason=failure or "This is a conservative ZIP-level screening estimate, not a property-specific one.", can_request=providers.rent is not None and failure is None,
        )
    return RentEstimateOut(
        available=False, is_demo=ctx.is_demo, can_request=providers.rent is not None and failure is None and not fetch,
        reason=failure or ("No rent estimate has been requested for this property yet." if providers.rent else "No rent estimate provider is configured."),
    )


@router.get("/{property_id}/value-estimate", response_model=ValueEstimateOut)
async def value_estimate(property_id: uuid.UUID, session: Session, user: OptionalUser, fetch: bool = False, refresh: bool = False) -> ValueEstimateOut:
    """Automated value estimate with the comparable sale listings it is based on."""
    ctx = await _require_context(session, property_id)
    providers = get_providers()
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().value_estimate_ttl_days)

    async def stored() -> ValueEstimate | None:
        return (
            await session.execute(
                select(ValueEstimate).where(ValueEstimate.property_id == property_id, ValueEstimate.fetched_at >= cutoff).options(selectinload(ValueEstimate.comparables)).order_by(ValueEstimate.fetched_at.desc())
            )
        ).scalars().first()

    refresh = refresh and bool(user and plans.is_unlimited(user))
    row = None if refresh else await stored()
    fetched_now, failure = False, None
    record = None
    if row is None and (fetch or refresh) and providers.value is not None:
        try:
            await plans.authorize_property_report(session, user, str(property_id))
            record = await providers.value.value_estimate(property_store.subject_for(ctx))
        except PlanLimitError as exc:
            failure = exc.message
        except ProviderError as exc:
            record, failure = None, _provider_failure(exc)
        if record is not None:
            async with session_scope() as write:
                await property_store.save_value_estimate(write, property_id, record)
            session.expire_all()
            row = await stored()
            fetched_now = True
        elif failure is None:
            failure = "The provider has no value estimate for this address."
    if row is None:
        return ValueEstimateOut(
            available=False, is_demo=ctx.is_demo, can_request=providers.value is not None and failure is None and not fetch,
            reason=failure or ("No value estimate has been requested yet." if providers.value else "No value estimate provider is configured."),
        )
    return ValueEstimateOut(
        available=True, provider=property_store.provider_name(row.provider_key), fetched_at=row.fetched_at, fetched_now=fetched_now, is_demo=ctx.is_demo,
        value=row.value, value_low=row.value_low, value_high=row.value_high, comparables=[_comp(c, rental=False) for c in row.comparables],
    )


@router.get("/{property_id}/str-estimate", response_model=StrEstimateOut)
async def str_estimate(property_id: uuid.UUID, session: Session, fetch: bool = False, refresh: bool = False) -> StrEstimateOut:
    """Short-term rental revenue estimate. Premium data is only requested when `fetch=true`."""
    ctx = await _require_context(session, property_id)
    providers = get_providers()
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().str_estimate_ttl_days)

    async def stored() -> ShortTermRentalEstimate | None:
        return (
            await session.execute(
                select(ShortTermRentalEstimate).where(ShortTermRentalEstimate.property_id == property_id, ShortTermRentalEstimate.fetched_at >= cutoff).order_by(ShortTermRentalEstimate.fetched_at.desc())
            )
        ).scalars().first()

    row = None if refresh else await stored()
    fetched_now, failure = False, None
    if row is None and (fetch or refresh) and providers.short_term is not None:
        try:
            record = await providers.short_term.str_estimate(property_store.subject_for(ctx))
        except ProviderError as exc:
            record, failure = None, _provider_failure(exc)
        if record is not None:
            async with session_scope() as write:
                await property_store.save_str_estimate(write, property_id, record)
            session.expire_all()
            row = await stored()
            fetched_now = True
        elif failure is None:
            failure = "The provider has no short-term rental estimate for this address."
    if row is None:
        reason = failure or (
            "No short-term rental estimate has been requested for this property yet."
            if providers.short_term
            else "No short-term rental analytics provider is configured (set AIRDNA_API_KEY). You can still enter a nightly rate and occupancy manually."
        )
        return StrEstimateOut(available=False, is_demo=ctx.is_demo, reason=reason, can_request=providers.short_term is not None and failure is None and not fetch)
    return StrEstimateOut(
        available=True, provider=property_store.provider_name(row.provider_key), fetched_at=row.fetched_at, fetched_now=fetched_now, is_demo=ctx.is_demo,
        level=row.level, adr=row.adr, occupancy_pct=row.occupancy_pct, occupancy_basis=row.occupancy_basis, annual_revenue=row.annual_revenue,
        cleaning_fee=row.cleaning_fee, adr_includes_cleaning_fee=row.adr_includes_cleaning_fee, avg_stay_nights=row.avg_stay_nights,
        seasonality=[Decimal(str(w)) for w in row.seasonality] if row.seasonality else None, comp_count=row.comp_count,
    )


@router.post("/{property_id}/tax-record", status_code=200)
async def fetch_tax_record(property_id: uuid.UUID, session: Session, user: OptionalUser) -> dict:
    """Look up the latest public property-tax record (one billable provider request)."""
    ctx = await _require_context(session, property_id)
    provider = get_providers().tax
    if provider is None:
        return {"available": False, "reason": "No tax record provider is configured in this data mode."}
    try:
        await plans.authorize_property_report(session, user, str(property_id))
    except PlanLimitError as exc:
        return {"available": False, "reason": exc.message}
    try:
        record = await provider.tax_record(property_store.subject_for(ctx))
    except ProviderError as exc:
        return {"available": False, "reason": _provider_failure(exc)}
    if record is None:
        return {"available": False, "reason": "No public tax record was found for this address."}
    async with session_scope() as write:
        await property_store.save_tax_record(write, property_id, record)
    return {"available": True, "annual_amount": float(record.annual_amount), "year": record.year, "source": record.source}
