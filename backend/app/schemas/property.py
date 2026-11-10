"""Property detail schemas."""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

from app.finance.results import Num
from app.schemas.analysis import PropertyContext


class ImageOut(BaseModel):
    url: str
    attribution: str | None = None


class PriceEventOut(BaseModel):
    event_date: date
    event_type: str
    price: Num | None = None
    source: str | None = None


class SourceOut(BaseModel):
    provider: str
    provider_listing_id: str
    price: Num | None = None
    status: str | None = None
    url: str | None = None
    fetched_at: datetime


class ComparableOut(BaseModel):
    formatted_address: str
    latitude: float | None = None
    longitude: float | None = None
    price: Num | None = None
    bedrooms: Num | None = None
    bathrooms: Num | None = None
    square_feet: int | None = None
    property_type: str | None = None
    year_built: int | None = None
    distance_miles: Num | None = None
    days_old: int | None = None
    similarity: Num | None = None
    listed_date: date | None = None


class EstimateEnvelope(BaseModel):
    """Common wrapper for on-demand provider estimates."""

    available: bool
    provider: str | None = None
    fetched_at: datetime | None = None
    fetched_now: bool = False
    is_demo: bool = False
    # When unavailable: why, and whether asking the provider (a billable request) could help.
    reason: str | None = None
    can_request: bool = False


class RentEstimateOut(EstimateEnvelope):
    level: str | None = None
    rent: Num | None = None
    rent_low: Num | None = None
    rent_high: Num | None = None
    annual_gross: Num | None = None
    comp_count: int = 0
    market_sample: int = 0
    comparables: list[ComparableOut] = []


class ValueEstimateOut(EstimateEnvelope):
    value: Num | None = None
    value_low: Num | None = None
    value_high: Num | None = None
    comparables: list[ComparableOut] = []


class StrEstimateOut(EstimateEnvelope):
    level: str | None = None
    adr: Num | None = None
    occupancy_pct: Num | None = None
    occupancy_basis: str | None = None
    annual_revenue: Num | None = None
    cleaning_fee: Num | None = None
    adr_includes_cleaning_fee: bool = False
    avg_stay_nights: Num | None = None
    seasonality: list[Num] | None = None
    comp_count: int = 0


class PropertyDetail(BaseModel):
    context: PropertyContext
    description: str | None = None
    lot_size_sqft: int | None = None
    listing_type: str | None = None
    mls_name: str | None = None
    mls_number: str | None = None
    agent_name: str | None = None
    office_name: str | None = None
    address_line2: str | None = None
    images: list[ImageOut] = []
    price_history: list[PriceEventOut] = []
    sources: list[SourceOut] = []
    attribution: list[str] = []
    is_favorite: bool = False
