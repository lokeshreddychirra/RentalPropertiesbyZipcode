"""Staged property search pipeline.

    1. resolve    locations → provider queries (geocoding only when a radius/county needs it)
    2. fetch      every page of matching listings (cached per page); never a silent first-page cut-off
    3. persist    deduplicate across providers and upsert
    4. screen     cheap filters on listing facts (price, beds, type, HOA, days on market, area)
    5. estimate   ZIP-level rent statistics (one call per ZIP) for inexpensive first-pass returns
    6. upgrade    paid property-level rent / STR estimates only for the most promising candidates
    7. rank       deterministic analysis + investment score for every remaining property

Anything that prevents full retrieval (budget, rate limit, provider failure, the
configured safety cap) is recorded in ``partial_reasons`` and shown to the user.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import statistics
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.core.config import get_settings
from app.core.db import session_scope
from app.core.redis import cache_get_json, cache_set_json, get_redis
from app.finance.scoring import ScoreWeights
from app.models.tables import MarketSnapshot
from app.providers.base import (
    BedroomStat,
    BudgetExceeded,
    ListingPage,
    ListingProvider,
    ListingQuery,
    ListingRecord,
    MarketStats,
    ProviderAuthError,
    ProviderError,
    RentEstimateRecord,
)
from app.providers.registry import ProviderSet, get_providers
from app.providers.usage import get_usage_tracker
from app.schemas.analysis import PropertyAnalysis, PropertyContext
from app.schemas.search import (
    JobProgress,
    MapPoint,
    MapResults,
    PropertyCard,
    ResultSummary,
    SearchFilters,
    SearchJob,
    SearchResults,
    SearchRunRequest,
    StrategySummary,
)

from . import property_store
from .analysis import analyze
from .dedupe import merge_listings

logger = logging.getLogger(__name__)

JOB_TTL_SECONDS = 6 * 3600
ProgressFn = Callable[[JobProgress], Awaitable[None]]


# --------------------------------------------------------------------------- geometry


def point_in_polygon(lng: float, lat: float, polygon: list[tuple[float, float]]) -> bool:
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def miles_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(a))


def polygon_circle(polygon: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Centre and radius (miles) of a circle covering the polygon."""
    lng = sum(p[0] for p in polygon) / len(polygon)
    lat = sum(p[1] for p in polygon) / len(polygon)
    radius = max(miles_between(lat, lng, p[1], p[0]) for p in polygon)
    return lat, lng, min(max(radius, 0.5), 100.0)


# --------------------------------------------------------------------------- job state


def _job_key(job_id: str) -> str:
    return f"searchjob:{job_id}"


def _result_key(job_id: str) -> str:
    return f"searchjob:{job_id}:result"


def request_hash(request: SearchRunRequest, data_mode: str) -> str:
    payload = request.model_dump(mode="json", exclude={"refresh"}, exclude_none=True)
    return hashlib.sha256(json.dumps({"mode": data_mode, **payload}, sort_keys=True).encode()).hexdigest()[:32]


async def save_job(job: SearchJob) -> None:
    await get_redis().set(_job_key(job.id), job.model_dump_json(), ex=JOB_TTL_SECONDS)


async def load_job(job_id: str) -> SearchJob | None:
    raw = await get_redis().get(_job_key(job_id))
    return SearchJob.model_validate_json(raw) if raw else None


async def create_job(request: SearchRunRequest) -> tuple[SearchJob, bool]:
    """Create a job, or return a completed cached job for an identical recent request.

    Returns (job, needs_run).
    """
    settings = get_settings()
    mode = settings.effective_data_mode
    digest = request_hash(request, mode)
    redis = get_redis()
    if not request.refresh:
        cached_id = await redis.get(f"searchcache:{digest}")
        if cached_id:
            cached = await load_job(cached_id)
            # Partial results (budget reached, provider error) are never reused: the next search retries.
            reusable = cached is not None and not cached.partial and cached.status in ("completed", "running", "queued")
            if cached and reusable and (cached.status != "completed" or await redis.exists(_result_key(cached_id))):
                cached.cached = cached.status == "completed"
                return cached, False
    job = SearchJob(id=uuid.uuid4().hex, status="queued", data_mode=mode, created_at=datetime.now(UTC), filters=request.filters)
    await save_job(job)
    await redis.set(f"searchjob:{job.id}:request", request.model_dump_json(), ex=JOB_TTL_SECONDS)
    await redis.set(f"searchcache:{digest}", job.id, ex=settings.search_result_ttl_seconds)
    return job, True


async def load_request(job_id: str) -> SearchRunRequest | None:
    raw = await get_redis().get(f"searchjob:{job_id}:request")
    return SearchRunRequest.model_validate_json(raw) if raw else None


# --------------------------------------------------------------------------- location resolution


class ResolvedSearch(BaseModel):
    queries: list[ListingQuery]
    county_filter: str | None = None
    circles: list[tuple[float, float, float]] = []  # lat, lng, radius — post-filter for radius searches
    warnings: list[str] = []


def _split_city(text: str, fallback_state: str | None) -> tuple[str, str | None]:
    if "," in text:
        city, state = (part.strip() for part in text.split(",", 1))
        return city, state.upper() or fallback_state
    return text.strip(), fallback_state


async def resolve_locations(filters: SearchFilters, providers: ProviderSet) -> ResolvedSearch:
    base = dict(
        min_price=filters.min_price,
        max_price=filters.max_price,
        min_beds=filters.min_beds,
        max_beds=filters.max_beds,
        property_types=list(filters.property_types),
        max_days_on_market=filters.max_days_on_market,
    )
    resolved = ResolvedSearch(queries=[])
    geocoder = providers.geocoder
    radius = filters.radius_miles

    async def around(label: str, kinds: tuple[str, ...], miles: float) -> bool:
        if geocoder is None:
            resolved.warnings.append(f"The {miles:g}-mile radius around {label} was not applied because no geocoding provider is configured (set MAPBOX_ACCESS_TOKEN). Showing results for {label} only.")
            return False
        try:
            hit = await geocoder.geocode(label, kinds=kinds)
        except ProviderError as exc:
            resolved.warnings.append(f"Could not geocode {label} ({exc.message}); the radius was not applied.")
            return False
        if hit is None:
            resolved.warnings.append(f"Could not locate {label}; the radius was not applied.")
            return False
        resolved.queries.append(ListingQuery(latitude=hit.latitude, longitude=hit.longitude, radius_miles=miles, **base))
        resolved.circles.append((hit.latitude, hit.longitude, miles))
        return True

    for zip_code in filters.zip_codes:
        if radius and await around(zip_code, ("postcode",), radius):
            continue
        resolved.queries.append(ListingQuery(zip_code=zip_code, **base))

    for entry in filters.cities:
        city, state = _split_city(entry, filters.state)
        label = f"{city}, {state}" if state else city
        if state is None:
            resolved.warnings.append(f'"{city}" has no state, so matching cities in any state may be returned. Use "City, ST" to be specific.')
        if radius and await around(label, ("place", "locality"), radius):
            continue
        resolved.queries.append(ListingQuery(city=city, state=state, **base))

    if filters.county and filters.state:
        resolved.county_filter = filters.county.lower().removesuffix(" county").strip()
        if not (filters.zip_codes or filters.cities):
            label = f"{filters.county.removesuffix(' County').removesuffix(' county')} County, {filters.state}"
            located = False
            if geocoder is not None:
                try:
                    hit = await geocoder.geocode(label, kinds=("district",))
                except ProviderError:
                    hit = None
                if hit is not None:
                    miles = 30.0
                    if hit.bbox:
                        west, south, east, north = hit.bbox
                        miles = min(max(miles_between(south, west, north, east) / 2, 5.0), 75.0)
                    resolved.queries.append(ListingQuery(latitude=hit.latitude, longitude=hit.longitude, radius_miles=round(miles, 1), **base))
                    located = True
            if not located:
                resolved.queries.append(ListingQuery(state=filters.state, **base))
                resolved.warnings.append(f"{label} was searched by scanning all {filters.state} listings and filtering by county, which uses more API requests. Configure a geocoding provider or add ZIP codes to narrow it.")
    elif filters.state and not (filters.zip_codes or filters.cities):
        resolved.queries.append(ListingQuery(state=filters.state, **base))
        resolved.warnings.append(f"State-wide search for {filters.state}: this can return a very large number of listings and use many API requests.")

    if filters.polygon and not resolved.queries:
        lat, lng, miles = polygon_circle(filters.polygon)
        resolved.queries.append(ListingQuery(latitude=lat, longitude=lng, radius_miles=round(miles, 2), **base))

    return resolved


# --------------------------------------------------------------------------- fetching


def _page_cache_key(kind: str, provider: Any, query: ListingQuery, offset: int) -> str:
    # Key on what is actually sent to the provider, so filters applied locally (price, beds, type)
    # never cause a new paid request for an area that is already cached.
    request_params = getattr(provider, "request_params", None)
    identity = json.dumps(request_params(query), sort_keys=True, default=str) if request_params else query.model_dump_json()
    return f"{kind}:" + hashlib.sha256(f"{provider.key}|{identity}|{offset}|{provider.page_size}".encode()).hexdigest()


async def _cached_page(provider: ListingProvider, query: ListingQuery, offset: int, refresh: bool) -> ListingPage:
    settings = get_settings()
    cacheable = provider.key != "demo"
    key = _page_cache_key("listings", provider, query, offset)
    if cacheable and not refresh:
        cached = await cache_get_json(key)
        if cached is not None:
            return ListingPage.model_validate(cached)
    page = await provider.search_listings(query, offset=offset, limit=provider.page_size)
    if cacheable:
        await cache_set_json(key, page.model_dump(mode="json"), settings.listing_cache_ttl_seconds)
    return page


class FetchOutcome(BaseModel):
    records: list[ListingRecord] = []
    pages: int = 0
    partial_reasons: list[str] = []
    fatal: str | None = None


async def fetch_all_listings(providers: ProviderSet, queries: list[ListingQuery], refresh: bool, on_page: Callable[[int, int], Awaitable[None]]) -> FetchOutcome:
    settings = get_settings()
    outcome = FetchOutcome()
    blocked: set[str] = set()
    for provider in providers.listing_providers:
        for query in queries:
            if provider.key in blocked:
                break
            offset = 0
            while True:
                if len(outcome.records) >= settings.max_listings_per_search:
                    outcome.partial_reasons.append(
                        f"Stopped after {len(outcome.records):,} listings (the configured MAX_LISTINGS_PER_SEARCH safety cap). More matching listings exist — narrow the area or raise the cap."
                    )
                    return outcome
                try:
                    page = await _cached_page(provider, query, offset, refresh)
                except BudgetExceeded as exc:
                    outcome.partial_reasons.append(f"{provider.name} API budget reached ({exc.message}); listings for {query.describe()} may be incomplete. Raise the budget in Settings to continue.")
                    blocked.add(provider.key)
                    break
                except ProviderAuthError as exc:
                    outcome.fatal = f"{provider.name}: {exc.message}"
                    blocked.add(provider.key)
                    break
                except ProviderError as exc:
                    outcome.partial_reasons.append(f"{provider.name} returned an error while loading {query.describe()} ({exc.message}); results for that area are incomplete.")
                    break
                outcome.records.extend(page.listings)
                outcome.pages += 1
                await on_page(outcome.pages, len(outcome.records))
                if not page.has_more or page.next_offset <= offset:
                    break
                offset = page.next_offset
    return outcome


# --------------------------------------------------------------------------- screening


def passes_listing_filters(record: ListingRecord, filters: SearchFilters, resolved: ResolvedSearch) -> bool:
    if record.status != "active" or record.price is None or record.price <= 0:
        return False
    if filters.min_price is not None and record.price < filters.min_price:
        return False
    if filters.max_price is not None and record.price > filters.max_price:
        return False
    if filters.min_beds is not None and (record.bedrooms is None or record.bedrooms < filters.min_beds):
        return False
    if filters.max_beds is not None and (record.bedrooms is None or record.bedrooms > filters.max_beds):
        return False
    if filters.property_types and record.property_type not in filters.property_types:
        return False
    # Vacant land cannot be rented as a home, so it is only included when explicitly requested.
    if not filters.property_types and record.property_type == "land":
        return False
    if filters.max_hoa is not None and record.hoa_fee_monthly is not None and record.hoa_fee_monthly > filters.max_hoa:
        return False
    if filters.max_days_on_market is not None and (record.days_on_market is None or record.days_on_market > filters.max_days_on_market):
        return False
    # Homes with an unknown build year are excluded only when a year range is requested.
    if filters.min_year_built is not None and (record.year_built is None or record.year_built < filters.min_year_built):
        return False
    if filters.max_year_built is not None and (record.year_built is None or record.year_built > filters.max_year_built):
        return False
    if filters.state and record.state and record.state != filters.state and not (filters.zip_codes or filters.cities):
        return False
    if resolved.county_filter and (record.county or "").lower().removesuffix(" county").strip() != resolved.county_filter:
        return False
    if filters.polygon:
        if record.latitude is None or record.longitude is None or not point_in_polygon(record.longitude, record.latitude, filters.polygon):
            return False
    return True


# --------------------------------------------------------------------------- market stats


async def get_market_stats(providers: ProviderSet, zip_code: str, *, refresh: bool = False) -> MarketStats | None:
    """ZIP market statistics, cached in Postgres for ``MARKET_STATS_TTL_DAYS``."""
    provider = providers.market
    if provider is None:
        return None
    settings = get_settings()
    cutoff = datetime.now(UTC) - timedelta(days=settings.market_stats_ttl_days)
    if not refresh:
        async with session_scope() as session:
            row = (
                await session.execute(select(MarketSnapshot).where(MarketSnapshot.zip_code == zip_code, MarketSnapshot.provider_key == provider.key))
            ).scalar_one_or_none()
        if row is not None and row.fetched_at >= cutoff:
            return MarketStats.model_validate(row.data)
    stats = await provider.market_stats(zip_code)
    if stats is None:
        return None
    async with session_scope() as session:
        stmt = insert(MarketSnapshot).values(id=uuid.uuid4(), zip_code=zip_code, provider_key=provider.key, data=stats.model_dump(mode="json"), fetched_at=stats.fetched_at)
        await session.execute(stmt.on_conflict_do_update(index_elements=["zip_code", "provider_key"], set_=dict(data=stmt.excluded.data, fetched_at=stmt.excluded.fetched_at)))
    return stats



async def cached_market_stats(providers: ProviderSet, zip_code: str) -> MarketStats | None:
    """Fresh stored statistics for a ZIP (market API first, then rental-listing aggregates) — never a paid call."""
    market = providers.market
    if market is None:
        return None
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().market_stats_ttl_days)
    async with session_scope() as session:
        rows = (
            await session.execute(
                select(MarketSnapshot).where(MarketSnapshot.zip_code == zip_code, MarketSnapshot.provider_key.in_([market.key, _rentals_key(market.key)]), MarketSnapshot.fetched_at >= cutoff)
            )
        ).scalars().all()
    by_key = {row.provider_key: MarketStats.model_validate(row.data) for row in rows}
    return by_key.get(market.key) or by_key.get(_rentals_key(market.key))


def _rentals_key(provider_key: str) -> str:
    return f"{provider_key}:rentals"


def stats_from_rentals(records: list[ListingRecord], provider_key: str, fetched_at: datetime) -> dict[str, MarketStats]:
    """Per-ZIP rent statistics aggregated from active long-term rental listings."""
    by_zip: dict[str, dict[str, ListingRecord]] = {}
    for record in records:
        rent = record.price
        if record.status != "active" or not record.zip_code or rent is None or not (Decimal(300) <= rent <= Decimal(50000)):
            continue
        by_zip.setdefault(record.zip_code, {})[record.formatted_address.lower()] = record  # one per address
    out: dict[str, MarketStats] = {}
    for zip_code, unique in by_zip.items():
        rows = list(unique.values())
        rents = [r.price for r in rows if r.price is not None]
        per_sqft = [r.price / r.square_feet for r in rows if r.price is not None and r.square_feet and r.square_feet >= 250]
        buckets: dict[int, list[Decimal]] = {}
        for r in rows:
            if r.bedrooms is not None and r.price is not None:
                buckets.setdefault(min(int(r.bedrooms), 6), []).append(r.price)
        out[zip_code] = MarketStats(
            provider=provider_key,
            zip_code=zip_code,
            median_rent=_median(rents),
            average_rent=(sum(rents, Decimal(0)) / len(rents)).quantize(Decimal("1")) if rents else None,
            rental_listings=len(rents),
            median_rent_per_sqft=_median(per_sqft),
            rent_by_bedrooms=[
                BedroomStat(bedrooms=beds, median=_median(values), average=(sum(values, Decimal(0)) / len(values)).quantize(Decimal("1")), low=min(values), high=max(values), count=len(values))
                for beds, values in sorted(buckets.items())
            ],
            fetched_at=fetched_at,
            source="rental_listings",
        )
    return out


async def _fetch_rentals(provider: Any, queries: list[ListingQuery], refresh: bool) -> tuple[list[ListingRecord], str | None]:
    """All pages (up to ``AREA_RENT_MAX_PAGES`` per location) of active rental listings, cached like sale listings."""
    settings = get_settings()
    records: list[ListingRecord] = []
    for query in queries:
        offset = 0
        for _ in range(max(settings.area_rent_max_pages, 1)):
            key = _page_cache_key("rentals", provider, ListingQuery(**query.model_dump(include={"zip_code", "city", "state", "latitude", "longitude", "radius_miles"})), offset)
            cached = None if refresh else await cache_get_json(key)
            if cached is not None:
                page = ListingPage.model_validate(cached)
            else:
                try:
                    page = await provider.search_rental_listings(query, offset=offset, limit=provider.page_size)
                except BudgetExceeded as exc:
                    return records, f"{provider.name} budget reached ({exc.message})"
                except ProviderError as exc:
                    return records, f"{provider.name} rental listings unavailable ({exc.message})"
                await cache_set_json(key, page.model_dump(mode="json"), settings.listing_cache_ttl_seconds)
            records.extend(page.listings)
            if not page.has_more or page.next_offset <= offset:
                break
            offset = page.next_offset
    return records, None


async def _save_snapshots(provider_key: str, stats: dict[str, MarketStats]) -> None:
    if not stats:
        return
    async with session_scope() as session:
        for zip_code, item in stats.items():
            stmt = insert(MarketSnapshot).values(id=uuid.uuid4(), zip_code=zip_code, provider_key=provider_key, data=item.model_dump(mode="json"), fetched_at=item.fetched_at)
            await session.execute(stmt.on_conflict_do_update(index_elements=["zip_code", "provider_key"], set_=dict(data=stmt.excluded.data, fetched_at=stmt.excluded.fetched_at)))


async def load_area_rent_stats(
    providers: ProviderSet, zip_counts: dict[str, int], queries: list[ListingQuery], *, refresh: bool, partial: list[str], warnings: list[str]
) -> dict[str, MarketStats]:
    """Rent statistics for the ZIP codes of the candidates, spending as few paid requests as possible.

    1. Fresh cached statistics (market API or rental-listing aggregates) — free.
    2. The area's active rental listings, aggregated per ZIP — one paginated request per searched
       location instead of one request per ZIP code.
    3. The market-statistics endpoint for ZIPs still lacking a reliable sample, capped at
       ``MARKET_STATS_FALLBACK_MAX`` per search (unlimited in demo mode).
    """
    market = providers.market
    if market is None or not zip_counts:
        return {}
    settings = get_settings()
    zips = sorted(zip_counts, key=lambda z: (-zip_counts[z], z))
    rentals_key = _rentals_key(market.key)
    result: dict[str, MarketStats] = {}

    if not refresh:
        cutoff = datetime.now(UTC) - timedelta(days=settings.market_stats_ttl_days)
        async with session_scope() as session:
            rows = (
                await session.execute(
                    select(MarketSnapshot).where(MarketSnapshot.zip_code.in_(zips), MarketSnapshot.provider_key.in_([market.key, rentals_key]), MarketSnapshot.fetched_at >= cutoff)
                )
            ).scalars().all()
        cached: dict[str, dict[str, MarketStats]] = {}
        for row in rows:
            cached.setdefault(row.zip_code, {})[row.provider_key] = MarketStats.model_validate(row.data)
        for zip_code, options in cached.items():
            for key in (market.key, rentals_key):  # prefer the provider's own statistics
                if key in options and options[key].has_reliable_rent():
                    result[zip_code] = options[key]
                    break

    missing = [z for z in zips if z not in result]
    search_rentals = getattr(market, "search_rental_listings", None)
    if missing and search_rentals is not None:
        records, problem = await _fetch_rentals(market, queries, refresh)
        aggregated = stats_from_rentals(records, market.key, datetime.now(UTC))
        await _save_snapshots(rentals_key, aggregated)
        for zip_code in missing:
            if zip_code in aggregated and aggregated[zip_code].has_reliable_rent():
                result[zip_code] = aggregated[zip_code]
        if problem:
            warnings.append(f"Area rents: {problem}.")

    missing = [z for z in zips if z not in result]
    cap = len(missing) if market.key == "demo" else max(settings.market_stats_fallback_max, 0)
    for zip_code in missing[:cap]:
        try:
            stats = await get_market_stats(providers, zip_code, refresh=refresh)
        except BudgetExceeded as exc:
            partial.append(f"Rent statistics could not be loaded for every ZIP code because the {market.name} budget was reached ({exc.message}). Properties without a rent estimate are shown as unranked.")
            break
        except ProviderError as exc:
            warnings.append(f"Rent statistics unavailable for ZIP {zip_code} ({exc.message}).")
            continue
        if stats is not None:
            result[zip_code] = stats
    skipped = [z for z in zips if z not in result]
    if skipped:
        count = sum(zip_counts[z] for z in skipped)
        warnings.append(
            f"{count} propert{'y' if count == 1 else 'ies'} in ZIP {', '.join(skipped[:6])}{'…' if len(skipped) > 6 else ''} "
            "had too few rental listings for an area rent estimate and are shown unranked. Open a property to request its own estimate."
        )
    return result


# --------------------------------------------------------------------------- cards


def _summary(result: Any, score: Any, confidence: str) -> StrategySummary:
    if not result.available:
        return StrategySummary(available=False)
    return StrategySummary(
        available=True,
        monthly_income=result.gross_monthly_income,
        gross_yield_pct=result.gross_yield_pct,
        net_yield_pct=result.net_yield_pct,
        cap_rate_pct=result.cap_rate_pct,
        cash_on_cash_pct=result.cash_on_cash_pct,
        monthly_cash_flow=result.monthly_cash_flow,
        noi_annual=result.noi_annual,
        dscr=result.dscr,
        break_even_occupancy_pct=result.break_even_occupancy_pct,
        total_cash_invested=result.total_cash_invested,
        score=score.score,
        confidence=confidence,  # type: ignore[arg-type]
    )


def build_card(ctx: PropertyContext, analysis: PropertyAnalysis) -> PropertyCard:
    primary = analysis.short_term if analysis.primary_strategy == "str" else analysis.long_term
    upfront = primary.total_cash_invested if primary.available else (analysis.long_term.total_cash_invested or analysis.short_term.total_cash_invested)
    return PropertyCard(
        id=ctx.id,
        formatted_address=ctx.formatted_address,
        address_line1=ctx.address_line1,
        city=ctx.city,
        state=ctx.state,
        zip_code=ctx.zip_code,
        county=ctx.county,
        latitude=ctx.latitude,
        longitude=ctx.longitude,
        property_type=ctx.property_type,
        bedrooms=ctx.bedrooms,
        bathrooms=ctx.bathrooms,
        square_feet=ctx.square_feet,
        year_built=ctx.year_built,
        price=ctx.price,
        days_on_market=ctx.days_on_market,
        hoa_fee_monthly=ctx.hoa_fee_monthly,
        image_url=ctx.image_url,
        listing_url=ctx.listing_url,
        listing_source=ctx.listing_source,
        last_seen_at=ctx.last_seen_at,
        is_demo=ctx.is_demo,
        rent_source=ctx.rent.source if ctx.rent else "none",
        str_source="provider" if ctx.short_term else "none",
        long_term=_summary(analysis.long_term, analysis.score_ltr, analysis.quality_ltr.label),
        short_term=_summary(analysis.short_term, analysis.score_str, analysis.quality_str.label),
        primary_strategy=analysis.primary_strategy,
        recommendation=analysis.recommendation.headline,
        recommendation_conditional=analysis.recommendation.conditional,
        score=analysis.overall_score,
        confidence=analysis.confidence,
        upfront_cash=upfront,
        legality_status=analysis.legality.status,
        legality_label=analysis.legality.label,
        badges=analysis.badges,
        price_reduction=ctx.price_reduction,
    )


def _analyze_batch(contexts: list[PropertyContext], defaults: BaseModel | None, weights: ScoreWeights | None) -> list[PropertyCard]:
    cards: list[PropertyCard] = []
    for ctx in contexts:
        try:
            cards.append(build_card(ctx, analyze(ctx, defaults=defaults, weights=weights)))
        except Exception:  # one bad record must not sink the whole search
            logger.exception("Could not analyse property %s", ctx.id)
    return cards


# --------------------------------------------------------------------------- pipeline


class SearchOutcome(BaseModel):
    cards: list[PropertyCard]
    listings_fetched: int
    partial_reasons: list[str]
    warnings: list[str]


async def _budgeted_top_n(provider_key: str, wanted: int) -> tuple[int, bool]:
    """How many paid lookups we may make now; second value is True when the budget cut it short."""
    if provider_key == "demo":
        return 10**9, False
    remaining = await get_usage_tracker().remaining_requests(provider_key)
    if remaining is None:
        return wanted, False
    return min(wanted, remaining), remaining < wanted


def explain_no_matches(records: list[ListingRecord], filters: SearchFilters) -> str | None:
    """Why every listing was screened out: which filters match nothing, with the range that exists."""
    active = [r for r in records if r.status == "active" and r.price and r.price > 0 and r.property_type != "land"]
    if not active:
        return None

    def span(values: list, fmt) -> str:
        values = [v for v in values if v is not None]
        return f"{fmt(min(values))}–{fmt(max(values))}" if values else "not recorded"

    money = lambda v: f"${int(v):,}"  # noqa: E731
    checks = []
    if filters.min_year_built is not None or filters.max_year_built is not None:
        lo, hi = filters.min_year_built, filters.max_year_built
        label = f"built {lo}–{hi}" if lo and hi else f"built {lo} or later" if lo else f"built {hi} or earlier"
        ok = [r for r in active if r.year_built is not None and (lo is None or r.year_built >= lo) and (hi is None or r.year_built <= hi)]
        checks.append((label, ok, f"homes here were built {span([r.year_built for r in active], str)}"))
    if filters.min_price is not None or filters.max_price is not None:
        ok = [r for r in active if (filters.min_price is None or r.price >= filters.min_price) and (filters.max_price is None or r.price <= filters.max_price)]
        checks.append(("your price range", ok, f"prices here are {span([r.price for r in active], money)}"))
    if filters.min_beds is not None or filters.max_beds is not None:
        ok = [r for r in active if r.bedrooms is not None and (filters.min_beds is None or r.bedrooms >= filters.min_beds) and (filters.max_beds is None or r.bedrooms <= filters.max_beds)]
        checks.append(("your bedroom range", ok, f"homes here have {span([r.bedrooms for r in active], lambda v: str(int(v)))} bedrooms"))
    if filters.property_types:
        ok = [r for r in active if r.property_type in filters.property_types]
        kinds = sorted({(r.property_type or "other").replace("_", " ") for r in active})
        checks.append(("the selected home types", ok, f"listings here are {', '.join(kinds)}"))
    if filters.max_hoa is not None:
        ok = [r for r in active if r.hoa_fee_monthly is None or r.hoa_fee_monthly <= filters.max_hoa]
        checks.append((f"HOA up to ${int(filters.max_hoa)}", ok, "every listing reports a higher HOA fee"))
    if filters.max_days_on_market is not None:
        ok = [r for r in active if r.days_on_market is not None and r.days_on_market <= filters.max_days_on_market]
        checks.append((f"listed within {filters.max_days_on_market} days", ok, "every listing has been on the market longer"))
    blockers = [f"none are {label} ({detail})" for label, ok, detail in checks if not ok]
    lead = f"{len(active)} active listing{'s' if len(active) != 1 else ''} were found in this area, but "
    if blockers:
        return lead + "; ".join(blockers) + ". Widen that filter to see results."
    if checks:
        return lead + "none match all of your filters together. Try removing one."
    return None


async def execute_search(request: SearchRunRequest, progress: ProgressFn, providers: ProviderSet | None = None) -> SearchOutcome:
    settings = get_settings()
    providers = providers or get_providers()
    filters = request.filters
    partial: list[str] = []
    state = JobProgress(stage="resolving", message="Resolving locations", percent=3)
    await progress(state)

    resolved = await resolve_locations(filters, providers)
    warnings = list(resolved.warnings)
    if not resolved.queries:
        return SearchOutcome(cards=[], listings_fetched=0, partial_reasons=[], warnings=warnings + ["No searchable location could be resolved from the filters."])

    # -- fetch ---------------------------------------------------------------
    async def on_page(pages: int, count: int) -> None:
        state.stage, state.pages_fetched, state.listings_found = "fetching_listings", pages, count
        state.message = f"Fetched {count:,} listings ({pages} page{'s' if pages != 1 else ''})"
        state.percent = min(10 + pages * 3, 45)
        await progress(state)

    fetched = await fetch_all_listings(providers, resolved.queries, request.refresh, on_page)
    partial.extend(fetched.partial_reasons)
    if fetched.fatal and not fetched.records:
        raise ProviderError("search", fetched.fatal)

    # -- dedupe + persist -----------------------------------------------------
    merged = merge_listings(fetched.records)
    state.stage, state.message, state.percent = "screening", f"Screening {len(merged):,} unique listings", 50
    await progress(state)
    if merged:
        async with session_scope() as session:
            await property_store.upsert_listings(session, merged)

    def in_circles(record: ListingRecord) -> bool:
        if not resolved.circles or record.latitude is None or record.longitude is None:
            return True
        return any(miles_between(lat, lng, record.latitude, record.longitude) <= miles * 1.02 for lat, lng, miles in resolved.circles)

    candidates = [m for m in merged if passes_listing_filters(m.primary, filters, resolved) and in_circles(m.primary)]
    candidate_ids = [m.property_id for m in candidates]
    if not candidate_ids:
        reason = explain_no_matches([m.primary for m in merged], filters)
        return SearchOutcome(cards=[], listings_fetched=len(merged), partial_reasons=partial, warnings=([reason] if reason else []) + warnings)

    # -- ZIP-level rent statistics (cheap: one request per ZIP) ----------------
    async with session_scope() as session:
        contexts = await property_store.load_contexts(session, candidate_ids)

    needs_rent = [c for c in contexts.values() if c.rent is None and c.zip_code]
    zip_counts: dict[str, int] = {}
    for c in needs_rent:
        zip_counts[c.zip_code] = zip_counts.get(c.zip_code, 0) + 1  # type: ignore[index]
    if zip_counts and providers.market is not None:
        state.stage, state.message, state.percent = "rent_estimates", f"Loading area rents for {len(zip_counts)} ZIP code{'s' if len(zip_counts) != 1 else ''}", 55
        await progress(state)
        market_by_zip = await load_area_rent_stats(providers, zip_counts, resolved.queries, refresh=request.refresh, partial=partial, warnings=warnings)
        rows: list[tuple[uuid.UUID, RentEstimateRecord]] = []
        for ctx in needs_rent:
            stats = market_by_zip.get(ctx.zip_code or "")
            found = stats.screening_rent(ctx.bedrooms, ctx.square_feet) if stats else None
            if found and stats:
                rent, low, high, sample = found
                rows.append((ctx.id, RentEstimateRecord(provider=stats.provider, level="market_zip", rent=rent, rent_low=low, rent_high=high, market_sample=sample, fetched_at=stats.fetched_at)))
        if rows:
            async with session_scope() as session:
                await property_store.save_market_rent_estimates(session, rows)
                contexts = await property_store.load_contexts(session, candidate_ids)

    # -- first-pass ranking ----------------------------------------------------
    cards = await asyncio.to_thread(_analyze_batch, list(contexts.values()), request.defaults, request.weights)
    cards_by_id = {card.id: card for card in cards}

    def promising() -> list[uuid.UUID]:
        """Candidates ordered by current long-term score (unranked properties last)."""
        ranked = sorted(cards_by_id.values(), key=lambda c: (c.long_term.score if c.long_term.score is not None else Decimal(-1), str(c.id)), reverse=True)
        return [c.id for c in ranked]

    # -- paid upgrades: property-level rent for the best candidates -------------
    upgraded: set[uuid.UUID] = set()
    semaphore = asyncio.Semaphore(settings.search_concurrency)

    async def run_stage(stage: str, label: str, ids: list[uuid.UUID], work: Callable[[PropertyContext], Awaitable[bool]], base_percent: int) -> list[str]:
        state.stage, state.estimates_done, state.estimates_total = stage, 0, len(ids)  # type: ignore[assignment]
        errors: list[str] = []
        stop = asyncio.Event()

        async def one(pid: uuid.UUID) -> None:
            if stop.is_set():
                return
            async with semaphore:
                if stop.is_set():
                    return
                try:
                    if await work(contexts[pid]):
                        upgraded.add(pid)
                except BudgetExceeded as exc:
                    if not stop.is_set():
                        errors.append(f"{label} stopped early: {exc.provider} budget reached ({exc.message}).")
                    stop.set()
                except ProviderError as exc:
                    if exc.status_code in (401, 403):
                        if not stop.is_set():
                            errors.append(f"{label} unavailable: {exc.message}.")
                        stop.set()
                    else:
                        logger.warning("%s failed for %s: %s", label, pid, exc)
                state.estimates_done += 1
                if state.estimates_done % 5 == 0 or state.estimates_done == state.estimates_total:
                    state.message = f"{label}: {state.estimates_done} of {state.estimates_total}"
                    state.percent = base_percent + int(14 * state.estimates_done / max(state.estimates_total, 1))
                    await progress(state)

        await asyncio.gather(*(one(pid) for pid in ids))
        return errors

    if providers.rent is not None and filters.strategy in ("ltr", "both"):
        rent_provider = providers.rent
        free = rent_provider.key == "demo"
        attempted: set[uuid.UUID] = set()
        max_total = len(cards_by_id) if free else settings.rent_avm_top_n * settings.rent_avm_max_rounds

        async def fetch_rent(ctx: PropertyContext) -> bool:
            record = await rent_provider.rent_estimate(property_store.subject_for(ctx))
            if record is None:
                return False
            async with session_scope() as session:
                await property_store.save_rent_estimate(session, ctx.id, record)
            return True

        def unverified(pid: uuid.UUID) -> bool:
            rent = contexts[pid].rent
            return rent is None or rent.source != "property_avm"

        # Verify the top of the ranking, then re-rank and verify whatever has moved into the top,
        # so the best-ranked properties rest on property-level estimates rather than area statistics.
        for _ in range(1 if free else max(settings.rent_avm_max_rounds, 1)):
            ranked = promising()
            window = ranked if free else ranked[: settings.rent_avm_top_n]
            targets = [pid for pid in window if pid not in attempted and unverified(pid)]
            room = max_total - len(attempted)
            if not free:
                remaining = await get_usage_tracker().remaining_requests(rent_provider.key)
                if remaining is not None and remaining < min(len(targets), room):
                    partial.append(f"Property-level rent estimates were limited by the {rent_provider.name} budget ({remaining} request(s) left this month); other properties use conservative ZIP-level estimates.")
                    room = min(room, remaining)
            targets = targets[: max(room, 0)]
            if not targets:
                break
            attempted.update(targets)
            errors = await run_stage("rent_estimates", "Property-level rent estimates", targets, fetch_rent, 62)
            partial.extend(errors)
            async with session_scope() as session:
                refreshed = await property_store.load_contexts(session, targets)
            contexts.update(refreshed)
            for card in await asyncio.to_thread(_analyze_batch, list(refreshed.values()), request.defaults, request.weights):
                cards_by_id[card.id] = card
            if errors:
                break
        upgraded.clear()

    if providers.short_term is not None and filters.strategy in ("str", "both"):
        str_provider = providers.short_term
        missing = [pid for pid in promising() if contexts[pid].short_term is None]
        allowed, limited = await _budgeted_top_n(str_provider.key, settings.str_estimate_top_n)
        targets = missing[:allowed]
        if limited and len(missing) > allowed:
            partial.append(f"Short-term rental estimates were limited to {allowed} properties by the {str_provider.name} budget.")

        async def fetch_str(ctx: PropertyContext) -> bool:
            record = await str_provider.str_estimate(property_store.subject_for(ctx))
            if record is None:
                return False
            async with session_scope() as session:
                await property_store.save_str_estimate(session, ctx.id, record)
            return True

        if targets:
            partial.extend(await run_stage("str_estimates", "Short-term rental estimates", targets, fetch_str, 78))
    elif providers.short_term is None and filters.strategy in ("str", "both"):
        warnings.append("Short-term rental revenue isn't estimated automatically (no short-term rental data source is connected). Open a property and enter a nightly rate and occupancy to model it.")

    # -- final ranking -----------------------------------------------------------
    state.stage, state.message, state.percent = "ranking", "Calculating returns and ranking", 94
    await progress(state)
    if upgraded:
        async with session_scope() as session:
            refreshed = await property_store.load_contexts(session, list(upgraded))
        for card in await asyncio.to_thread(_analyze_batch, list(refreshed.values()), request.defaults, request.weights):
            cards_by_id[card.id] = card

    return SearchOutcome(cards=list(cards_by_id.values()), listings_fetched=len(merged), partial_reasons=partial, warnings=warnings)


async def run_search_job(job_id: str) -> None:
    """Entry point used by the worker (and inline mode)."""
    job = await load_job(job_id)
    request = await load_request(job_id)
    if job is None or request is None:
        logger.warning("Search job %s expired before it could run", job_id)
        return
    job.status = "running"
    await save_job(job)

    async def progress(update: JobProgress) -> None:
        job.progress = update.model_copy()
        await save_job(job)

    try:
        outcome = await execute_search(request, progress)
    except Exception as exc:
        logger.exception("Search job %s failed", job_id)
        job.status = "failed"
        job.error = exc.message if isinstance(exc, ProviderError) else "The search could not be completed. Please try again."
        job.finished_at = datetime.now(UTC)
        await save_job(job)
        await get_redis().delete(f"searchcache:{request_hash(request, job.data_mode)}")
        return

    snapshot = {"cards": [card.model_dump(mode="json") for card in outcome.cards]}
    await get_redis().set(_result_key(job_id), json.dumps(snapshot), ex=JOB_TTL_SECONDS)
    job.status = "completed"
    job.partial = bool(outcome.partial_reasons)
    job.partial_reasons = list(dict.fromkeys(outcome.partial_reasons))
    job.warnings = list(dict.fromkeys(outcome.warnings))
    job.result_count = len(outcome.cards)
    job.listings_fetched = outcome.listings_fetched
    job.progress = JobProgress(stage="done", message=f"Ranked {len(outcome.cards):,} properties", percent=100, pages_fetched=job.progress.pages_fetched, listings_found=job.progress.listings_found)
    job.finished_at = datetime.now(UTC)
    await save_job(job)
    if job.partial:
        await get_redis().delete(f"searchcache:{request_hash(request, job.data_mode)}")


# --------------------------------------------------------------------------- querying results


def _view(card: PropertyCard, strategy: str) -> StrategySummary | None:
    """The strategy whose metrics drive filtering and sorting for this card."""
    if strategy == "ltr":
        return card.long_term
    if strategy == "str":
        return card.short_term
    if card.primary_strategy == "str":
        return card.short_term
    if card.primary_strategy == "ltr":
        return card.long_term
    return None


def passes_metric_filters(card: PropertyCard, filters: SearchFilters) -> bool:
    thresholds = (
        (filters.min_gross_yield, "gross_yield_pct"),
        (filters.min_net_yield, "net_yield_pct"),
        (filters.min_cap_rate, "cap_rate_pct"),
        (filters.min_cash_on_cash, "cash_on_cash_pct"),
        (filters.min_cash_flow, "monthly_cash_flow"),
    )
    active = [(minimum, attr) for minimum, attr in thresholds if minimum is not None]
    view = _view(card, filters.strategy)
    if filters.strategy in ("ltr", "str") and (view is None or not view.available) and active:
        return False
    if not active:
        return True
    if view is None or not view.available:
        return False
    for minimum, attr in active:
        value = getattr(view, attr)
        if value is None or value < minimum:
            return False
    return True


_SORTS: dict[str, tuple[Callable[[PropertyCard, StrategySummary | None], Any], bool]] = {
    # key -> (value getter, descending)
    "gross_yield": (lambda c, v: v.gross_yield_pct if v else None, True),
    "net_yield": (lambda c, v: v.net_yield_pct if v else None, True),
    "cap_rate": (lambda c, v: v.cap_rate_pct if v else None, True),
    "cash_on_cash": (lambda c, v: v.cash_on_cash_pct if v else None, True),
    "cash_flow": (lambda c, v: v.monthly_cash_flow if v else None, True),
    "upfront": (lambda c, v: (v.total_cash_invested if v and v.available else None) or c.upfront_cash, False),
    # A cash purchase has no debt to cover, so it ranks above any finite DSCR.
    "dscr": (lambda c, v: (v.dscr if v.dscr is not None else Decimal("1e9")) if v and v.available else None, True),
    "ltr_return": (lambda c, v: c.long_term.cash_on_cash_pct, True),
    "str_return": (lambda c, v: c.short_term.cash_on_cash_pct, True),
    "price_asc": (lambda c, v: c.price, False),
    "price_desc": (lambda c, v: c.price, True),
    "newest": (lambda c, v: c.days_on_market, False),
}


def sort_cards(cards: list[PropertyCard], sort: str, strategy: str) -> list[PropertyCard]:
    if sort == "score":
        def getter(card: PropertyCard, view: StrategySummary | None) -> Any:
            if strategy == "both":
                return card.score
            return view.score if view else None
        descending = True
    else:
        getter, descending = _SORTS[sort]

    keyed: list[tuple[Any, PropertyCard]] = []
    missing: list[PropertyCard] = []
    for card in cards:
        value = getter(card, _view(card, strategy))
        if value is None:
            missing.append(card)
        else:
            keyed.append((value, card))
    keyed.sort(key=lambda pair: (pair[0], str(pair[1].id)), reverse=descending)
    # Properties with no value for the chosen metric always rank last.
    return [card for _, card in keyed] + sorted(missing, key=lambda c: str(c.id))


def _median(values: list[Decimal]) -> Decimal | None:
    return Decimal(str(statistics.median(values))).quantize(Decimal("0.01")) if values else None


async def load_cards(job_id: str) -> list[PropertyCard] | None:
    raw = await get_redis().get(_result_key(job_id))
    if raw is None:
        return None
    return [PropertyCard.model_validate(item) for item in json.loads(raw)["cards"]]


def filter_cards(
    cards: list[PropertyCard],
    filters: SearchFilters,
    *,
    bbox: tuple[float, float, float, float] | None = None,
    polygon: list[tuple[float, float]] | None = None,
) -> list[PropertyCard]:
    out = []
    for card in cards:
        if not passes_metric_filters(card, filters):
            continue
        if bbox or polygon:
            if card.latitude is None or card.longitude is None:
                continue
            if bbox and not (bbox[0] <= card.longitude <= bbox[2] and bbox[1] <= card.latitude <= bbox[3]):
                continue
            if polygon and not point_in_polygon(card.longitude, card.latitude, polygon):
                continue
        out.append(card)
    return out


def summarize(all_cards: list[PropertyCard], matched: list[PropertyCard], strategy: str) -> ResultSummary:
    views = [v for v in (_view(card, strategy) for card in matched) if v is not None and v.available]
    scores = [card.score if strategy == "both" else (_view(card, strategy).score if _view(card, strategy) else None) for card in matched]  # type: ignore[union-attr]
    scores = [s for s in scores if s is not None]
    return ResultSummary(
        total=len(all_cards),
        matched=len(matched),
        median_price=_median([c.price for c in matched if c.price is not None]),
        median_gross_yield_pct=_median([v.gross_yield_pct for v in views if v.gross_yield_pct is not None]),
        median_cap_rate_pct=_median([v.cap_rate_pct for v in views if v.cap_rate_pct is not None]),
        median_cash_flow=_median([v.monthly_cash_flow for v in views if v.monthly_cash_flow is not None]),
        positive_cash_flow_count=sum(1 for v in views if v.monthly_cash_flow is not None and v.monthly_cash_flow > 0),
        average_score=(sum(scores, Decimal(0)) / len(scores)).quantize(Decimal("0.1")) if scores else None,
    )


def page_results(
    job: SearchJob,
    cards: list[PropertyCard],
    *,
    sort: str,
    page: int,
    page_size: int,
    bbox: tuple[float, float, float, float] | None = None,
    polygon: list[tuple[float, float]] | None = None,
) -> SearchResults:
    strategy = job.filters.strategy
    matched = sort_cards(filter_cards(cards, job.filters, bbox=bbox, polygon=polygon), sort, strategy)
    total = len(matched)
    start = (page - 1) * page_size
    return SearchResults(
        job=job,
        items=matched[start : start + page_size],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=max(math.ceil(total / page_size), 1),
        sort=sort,  # type: ignore[arg-type]
        strategy=strategy,
        summary=summarize(cards, matched, strategy),
    )


def map_points(job: SearchJob, cards: list[PropertyCard]) -> MapResults:
    matched = filter_cards(cards, job.filters)
    points = []
    for card in matched:
        if card.latitude is None or card.longitude is None:
            continue
        view = _view(card, job.filters.strategy)
        points.append(
            MapPoint(
                id=card.id,
                latitude=card.latitude,
                longitude=card.longitude,
                price=card.price,
                gross_yield_pct=view.gross_yield_pct if view and view.available else None,
                monthly_cash_flow=view.monthly_cash_flow if view and view.available else None,
                score=card.score if job.filters.strategy == "both" else (view.score if view else None),
                address=card.address_line1 or card.formatted_address,
            )
        )
    return MapResults(points=points, total=len(points))
