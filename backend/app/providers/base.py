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


class BedroomStat(BaseModel):
    bedrooms: int
    median: Decimal | None = None
    average: Decimal | None = None
    low: Decimal | None = None
    high: Decimal | None = None
    count: int = 0
    median_price_per_sqft: Decimal | None = None
    median_days_on_market: Decimal | None = None


class MarketHistoryPoint(BaseModel):
    month: str  # YYYY-MM
    median_rent: Decimal | None = None
    median_sale_price: Decimal | None = None
    rental_listings: int | None = None
    sale_listings: int | None = None


class MarketStats(BaseModel):
    provider: str
    zip_code: str
    median_rent: Decimal | None = None
    average_rent: Decimal | None = None
    rental_listings: int = 0
    median_rent_per_sqft: Decimal | None = None
    rental_median_days_on_market: Decimal | None = None
    rent_by_bedrooms: list[BedroomStat] = Field(default_factory=list)
    median_sale_price: Decimal | None = None
    average_sale_price: Decimal | None = None
    sale_listings: int = 0
    median_price_per_sqft: Decimal | None = None
    sale_median_days_on_market: Decimal | None = None
    sale_by_bedrooms: list[BedroomStat] = Field(default_factory=list)
    history: list[MarketHistoryPoint] = Field(default_factory=list)
    fetched_at: datetime
    is_demo: bool = False

    def rent_for_bedrooms(self, bedrooms: Decimal | None) -> tuple[Decimal, Decimal | None, Decimal | None, int] | None:
        """ZIP median rent for a bedroom count: (rent, low, high, sample) or None."""
        if bedrooms is None:
            return None
        target = int(bedrooms)
        for stat in self.rent_by_bedrooms:
            if stat.bedrooms == target and (stat.median or stat.average):
                rent = stat.median or stat.average
                assert rent is not None
                return rent, stat.low, stat.high, stat.count
        return None


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
