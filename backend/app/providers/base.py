"""Provider-neutral records and adapter interfaces.

Every external data source is wrapped in an adapter that returns these records,
so the rest of the application never depends on a vendor's response shape.
Adding an MLS / RESO Web API feed means implementing ``ListingProvider`` and
registering it in :mod:`app.providers.registry`.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from app.finance.results import Num

PropertyType = Literal["single_family", "condo", "townhouse", "multi_family", "manufactured", "apartment", "land", "other"]
PROPERTY_TYPES: tuple[str, ...] = ("single_family", "condo", "townhouse", "multi_family", "manufactured", "apartment", "land", "other")
PROPERTY_TYPE_LABELS = {
    "single_family": "Single Family",
    "condo": "Condo",
    "townhouse": "Townhouse",
    "multi_family": "Multi-Family",
    "manufactured": "Manufactured",
    "apartment": "Apartment",
    "land": "Land",
    "other": "Other",
}


# --------------------------------------------------------------------------- errors


class ProviderError(Exception):
    """A provider call failed. ``retryable`` tells the caller whether trying later may help."""

    def __init__(self, provider: str, message: str, *, status_code: int | None = None, retryable: bool = False):
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


class ProviderAuthError(ProviderError):
    pass


class ProviderRateLimited(ProviderError):
    def __init__(self, provider: str, message: str = "rate limit exceeded"):
        super().__init__(provider, message, status_code=429, retryable=True)


class BudgetExceeded(ProviderError):
    """The configured monthly request or cost budget for a provider is used up."""

    def __init__(self, provider: str, message: str):
        super().__init__(provider, message, retryable=False)


class ProviderNotConfigured(ProviderError):
    def __init__(self, provider: str, message: str = "provider is not configured"):
        super().__init__(provider, message)


# --------------------------------------------------------------------------- records


class PriceEvent(BaseModel):
    event_date: date
    event_type: str  # listed | price_change | removed | sold
    price: Decimal | None = None


class ListingRecord(BaseModel):
    provider: str
    provider_listing_id: str
    status: Literal["active", "inactive", "unknown"]
    listing_type: str | None = None
    formatted_address: str
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    county: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    property_type: PropertyType | None = None
    bedrooms: Decimal | None = None
    bathrooms: Decimal | None = None
    square_feet: int | None = None
    lot_size_sqft: int | None = None
    year_built: int | None = None
    price: Decimal | None = None
    listed_date: date | None = None
    removed_date: date | None = None
    days_on_market: int | None = None
    hoa_fee_monthly: Decimal | None = None
    property_tax_annual: Decimal | None = None
    property_tax_year: int | None = None
    description: str | None = None
    listing_url: str | None = None
    image_urls: list[str] = Field(default_factory=list)
    image_attribution: str | None = None
    mls_name: str | None = None
    mls_number: str | None = None
    agent_name: str | None = None
    office_name: str | None = None
    last_seen_at: datetime | None = None
    source_updated_at: datetime | None = None
    price_history: list[PriceEvent] = Field(default_factory=list)
    is_demo: bool = False


class ListingQuery(BaseModel):
    """One location to search. Exactly one of zip / city+state / point+radius / state is used."""

    zip_code: str | None = None
    city: str | None = None
    state: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    radius_miles: float | None = None
    min_price: Decimal | None = None
    max_price: Decimal | None = None
    min_beds: int | None = None
    max_beds: int | None = None
    property_types: list[str] = Field(default_factory=list)
    max_days_on_market: int | None = None

    def describe(self) -> str:
        if self.latitude is not None and self.longitude is not None and self.radius_miles:
            return f"{self.radius_miles:g} mi around {self.latitude:.4f},{self.longitude:.4f}"
        if self.zip_code:
            return f"ZIP {self.zip_code}"
        if self.city:
            return f"{self.city}, {self.state}" if self.state else self.city
        return self.state or "unknown location"


class ListingPage(BaseModel):
    listings: list[ListingRecord]
    has_more: bool
    next_offset: int
    total_count: int | None = None  # when the provider reports it


class Comparable(BaseModel):
    formatted_address: str
    latitude: float | None = None
    longitude: float | None = None
    price: Decimal | None = None  # monthly rent for rental comps, price for sale comps
    bedrooms: Decimal | None = None
    bathrooms: Decimal | None = None
    square_feet: int | None = None
    property_type: PropertyType | None = None
    year_built: int | None = None
    distance_miles: Decimal | None = None
    days_old: int | None = None
    similarity: Decimal | None = None
    listed_date: date | None = None


class RentEstimateRecord(BaseModel):
    provider: str
    level: Literal["property", "market_zip"]
    rent: Decimal
    rent_low: Decimal | None = None
    rent_high: Decimal | None = None
    comparables: list[Comparable] = Field(default_factory=list)
    market_sample: int = 0
    fetched_at: datetime


class ValueEstimateRecord(BaseModel):
    provider: str
    value: Decimal
    value_low: Decimal | None = None
    value_high: Decimal | None = None
    comparables: list[Comparable] = Field(default_factory=list)
    fetched_at: datetime


class StrEstimateRecord(BaseModel):
    provider: str
    level: Literal["property", "market"]
    adr: Decimal
    occupancy_pct: Decimal
    occupancy_basis: Literal["available", "calendar"] = "available"
    annual_revenue: Decimal | None = None
    cleaning_fee: Decimal | None = None
    adr_includes_cleaning_fee: bool = False
    avg_stay_nights: Decimal | None = None
    seasonality: list[Decimal] | None = None  # 12 relative monthly weights
    comp_count: int = 0
    fetched_at: datetime


class TaxRecord(BaseModel):
    provider: str
    annual_amount: Decimal
    year: int
    source: str


# Minimum rental listings behind a ZIP-level statistic before it is used for screening.
MIN_BEDROOM_SAMPLE = 5
MIN_ZIP_SAMPLE = 20


class BedroomStat(BaseModel):
    bedrooms: int
    median: Num | None = None
    average: Num | None = None
    low: Num | None = None
    high: Num | None = None
    count: int = 0
    median_price_per_sqft: Num | None = None
    median_days_on_market: Num | None = None


class MarketHistoryPoint(BaseModel):
    month: str  # YYYY-MM
    median_rent: Num | None = None
    median_sale_price: Num | None = None
    rental_listings: int | None = None
    sale_listings: int | None = None


class MarketStats(BaseModel):
    provider: str
    zip_code: str
    median_rent: Num | None = None
    average_rent: Num | None = None
    rental_listings: int = 0
    median_rent_per_sqft: Num | None = None
    rental_median_days_on_market: Num | None = None
    rent_by_bedrooms: list[BedroomStat] = Field(default_factory=list)
    median_sale_price: Num | None = None
    average_sale_price: Num | None = None
    sale_listings: int = 0
    median_price_per_sqft: Num | None = None
    sale_median_days_on_market: Num | None = None
    sale_by_bedrooms: list[BedroomStat] = Field(default_factory=list)
    history: list[MarketHistoryPoint] = Field(default_factory=list)
    fetched_at: datetime
    is_demo: bool = False
    # "market_api": the provider's market-statistics endpoint; "rental_listings": aggregated locally
    # from the area's active rental listings.
    source: str = "market_api"

    def has_reliable_rent(self) -> bool:
        """True when ``screening_rent`` can produce an estimate for at least some homes."""
        return self.rental_listings >= MIN_ZIP_SAMPLE or any(
            (stat.median or stat.average) and stat.count >= MIN_BEDROOM_SAMPLE for stat in self.rent_by_bedrooms
        )

    def screening_rent(self, bedrooms: Decimal | None, square_feet: int | None) -> tuple[Decimal, Decimal | None, Decimal | None, int] | None:
        """Conservative ZIP-level rent for first-pass screening: (rent, low, high, sample) or None.

        Two area-level estimates are considered and the **lower** one is used, so that an
        unverified property cannot outrank one with a property-specific estimate merely
        because a thin statistic happens to be high:

        * the ZIP median rent for the bedroom count (needs at least 5 rental listings), and
        * the home's living area × the ZIP median rent per square foot (needs at least 20),
          capped at the highest reliable bedroom median when the home's own bedroom count
          has no reliable statistic.

        With neither available there is no reliable estimate and None is returned.
        """
        reliable = {
            stat.bedrooms: stat for stat in self.rent_by_bedrooms if (stat.median or stat.average) and stat.count >= MIN_BEDROOM_SAMPLE
        }
        candidates: list[tuple[Decimal, Decimal | None, Decimal | None, int]] = []
        bucket = reliable.get(int(bedrooms)) if bedrooms is not None else None
        if bucket is not None:
            candidates.append(((bucket.median or bucket.average), bucket.low, bucket.high, bucket.count))  # type: ignore[arg-type]
        if square_feet and self.median_rent_per_sqft and self.rental_listings >= MIN_ZIP_SAMPLE:
            by_size = (Decimal(square_feet) * self.median_rent_per_sqft).quantize(Decimal("1"))
            if bucket is None and reliable:
                # Rent per square foot falls as homes get larger, so for sizes with no reliable
                # bedroom statistic the size-based figure is capped at the highest reliable median.
                by_size = min(by_size, max((stat.median or stat.average) for stat in reliable.values()))  # type: ignore[type-var]
            if by_size > 0:
                candidates.append((by_size, None, None, self.rental_listings))
        return min(candidates, key=lambda c: c[0]) if candidates else None


class GeocodeResult(BaseModel):
    name: str
    latitude: float
    longitude: float
    bbox: tuple[float, float, float, float] | None = None  # west, south, east, north
    kind: str | None = None


class SubjectProperty(BaseModel):
    """What an estimate provider needs to know about the home being valued."""

    formatted_address: str
    latitude: float | None = None
    longitude: float | None = None
    zip_code: str | None = None
    city: str | None = None
    state: str | None = None
    property_type: str | None = None
    bedrooms: Decimal | None = None
    bathrooms: Decimal | None = None
    square_feet: int | None = None
    price: Decimal | None = None
    seed: str | None = None  # stable id; used by the demo provider for determinism


# --------------------------------------------------------------------------- interfaces


@runtime_checkable
class ListingProvider(Protocol):
    key: str
    name: str
    attribution: str
    page_size: int

    async def search_listings(self, query: ListingQuery, *, offset: int, limit: int) -> ListingPage: ...


@runtime_checkable
class RentProvider(Protocol):
    key: str
    name: str

    async def rent_estimate(self, subject: SubjectProperty) -> RentEstimateRecord | None: ...


@runtime_checkable
class ValueProvider(Protocol):
    key: str
    name: str

    async def value_estimate(self, subject: SubjectProperty) -> ValueEstimateRecord | None: ...


@runtime_checkable
class TaxProvider(Protocol):
    key: str
    name: str

    async def tax_record(self, subject: SubjectProperty) -> TaxRecord | None: ...


@runtime_checkable
class MarketProvider(Protocol):
    key: str
    name: str

    async def market_stats(self, zip_code: str) -> MarketStats | None: ...


@runtime_checkable
class StrProvider(Protocol):
    key: str
    name: str

    async def str_estimate(self, subject: SubjectProperty) -> StrEstimateRecord | None: ...


@runtime_checkable
class Geocoder(Protocol):
    key: str

    async def geocode(self, query: str, *, kinds: tuple[str, ...] = ()) -> GeocodeResult | None: ...
