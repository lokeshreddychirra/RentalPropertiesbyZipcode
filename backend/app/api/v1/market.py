"""Market analytics (ZIP-level rent and sale statistics)."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import OptionalUser, Session, rate_limit
from app.core.errors import AppError, NotFoundError
from app.finance.results import Num
from app.models.tables import Property
from app.providers.base import BudgetExceeded, MarketStats, ProviderError
from app.providers.registry import get_providers
from app.schemas.analysis import LegalityInfo
from app.services.property_store import LegalityResolver
from app.services.search import cached_market_stats, get_market_stats

router = APIRouter(prefix="/market", tags=["market"])


class BedroomYield(BaseModel):
    bedrooms: int
    median_rent: Num | None = None
    median_price: Num | None = None
    gross_yield_pct: Num | None = None
    rental_sample: int = 0
    sale_sample: int = 0


class ZipMarket(BaseModel):
    stats: MarketStats
    city: str | None = None
    state: str | None = None
    price_to_rent_ratio: Num | None = None
    gross_yield_pct: Num | None = None
    yield_by_bedrooms: list[BedroomYield] = []
    legality: LegalityInfo


class MarketSummary(BaseModel):
    zip_codes: list[str]
    markets: list[ZipMarket]
    unavailable: list[str] = []
    notes: list[str] = []
    is_demo: bool = False
    methodology: str = (
        "Gross yield = median monthly rent × 12 / median asking price, from active listings in the ZIP code. "
        "It compares typical rents with typical prices and is not the yield of any specific property."
    )


def _ratio(stats: MarketStats) -> tuple[Decimal | None, Decimal | None]:
    if not stats.median_rent or not stats.median_sale_price or stats.median_rent <= 0:
        return None, None
    annual = stats.median_rent * 12
    return (stats.median_sale_price / annual).quantize(Decimal("0.1")), (annual / stats.median_sale_price * 100).quantize(Decimal("0.01"))


@router.get("/summary", response_model=MarketSummary, dependencies=[rate_limit("market", 30, 60)])
async def market_summary(
    session: Session,
    user: OptionalUser,
    zip_codes: Annotated[list[str] | None, Query(description="Up to 8 ZIP codes")] = None,
    city: str | None = None,
    state: str | None = None,
) -> MarketSummary:
    """Rent, price and yield statistics per ZIP code.

    Pass ZIP codes directly, or a city and state — the ZIP codes are then taken from listings already
    retrieved for that city (run a property search there first).
    """
    providers = get_providers()
    notes: list[str] = []
    zips = [z.strip() for z in (zip_codes or []) if z.strip()]
    for z in zips:
        if not (len(z) == 5 and z.isdigit()):
            raise AppError(f"'{z}' is not a 5-digit ZIP code", code="validation_error", status_code=422)
    if not zips:
        if not city:
            raise AppError("Provide zip_codes, or a city and state", code="validation_error", status_code=422)
        query = select(Property.zip_code, func.count()).where(func.lower(Property.city) == city.strip().lower(), Property.zip_code.is_not(None), Property.is_demo == providers.is_demo)
        if state:
            query = query.where(Property.state == state.strip().upper())
        rows = (await session.execute(query.group_by(Property.zip_code).order_by(func.count().desc()).limit(8))).all()
        zips = [row[0] for row in rows]
        if not zips:
            raise NotFoundError(f"No listings have been retrieved for {city}{', ' + state if state else ''} yet. Run a property search there first, or pass ZIP codes directly.")
        notes.append(f"Showing the {len(zips)} ZIP code(s) with the most retrieved listings in {city}.")
    zips = list(dict.fromkeys(zips))[:8]

    resolver = await LegalityResolver.load(session)
    markets: list[ZipMarket] = []
    unavailable: list[str] = []
    for zip_code in zips:
        try:
            # Only administrators trigger paid market-data requests; everyone else sees stored data
            # (gathered by searches in that ZIP code).
            if providers.is_demo or (user is not None and user.role == "admin"):
                stats = await get_market_stats(providers, zip_code)
            else:
                stats = await cached_market_stats(providers, zip_code)
        except BudgetExceeded as exc:
            notes.append(f"Market data for some ZIP codes was not loaded: {exc.provider} budget reached ({exc.message}).")
            unavailable.extend(z for z in zips if z not in {m.stats.zip_code for m in markets} and z not in unavailable)
            break
        except ProviderError as exc:
            notes.append(f"Market data for {zip_code} is unavailable ({exc.message}).")
            unavailable.append(zip_code)
            continue
        if stats is None:
            unavailable.append(zip_code)
            continue
        place = (await session.execute(select(Property.city, Property.state, Property.county).where(Property.zip_code == zip_code).limit(1))).first()
        ratio, gross = _ratio(stats)
        sale_by_beds = {s.bedrooms: s for s in stats.sale_by_bedrooms}
        by_beds = []
        for rent in stats.rent_by_bedrooms:
            sale = sale_by_beds.get(rent.bedrooms)
            yield_pct = None
            if rent.median and sale and sale.median and sale.median > 0:
                yield_pct = (rent.median * 12 / sale.median * 100).quantize(Decimal("0.01"))
            by_beds.append(BedroomYield(bedrooms=rent.bedrooms, median_rent=rent.median, median_price=sale.median if sale else None, gross_yield_pct=yield_pct, rental_sample=rent.count, sale_sample=sale.count if sale else 0))
        markets.append(
            ZipMarket(
                stats=stats,
                city=place[0] if place else None,
                state=place[1] if place else None,
                price_to_rent_ratio=ratio,
                gross_yield_pct=gross,
                yield_by_bedrooms=by_beds,
                legality=resolver.resolve(zip_code=zip_code, city=place[0] if place else None, county=place[2] if place else None, state=place[1] if place else None, is_demo=stats.is_demo),
            )
        )
    return MarketSummary(zip_codes=zips, markets=markets, unavailable=unavailable, notes=notes, is_demo=providers.is_demo)
