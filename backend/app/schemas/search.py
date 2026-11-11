"""Search request / response schemas."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.finance.quality import ConfidenceLabel
from app.finance.results import Num
from app.finance.scoring import ScoreWeights
from app.providers.base import PropertyType
from app.schemas.analysis import AssumptionOverrides, Badge, PriceReduction

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
    "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
}

SortKey = Literal[
    "score", "gross_yield", "net_yield", "cap_rate", "cash_on_cash", "cash_flow", "upfront", "dscr", "ltr_return", "str_return", "price_asc", "price_desc", "newest",
]
SORT_LABELS: dict[str, str] = {
    "score": "Best risk-adjusted investment score",
    "gross_yield": "Highest gross rental yield",
    "net_yield": "Highest net rental yield",
    "cap_rate": "Highest cap rate",
    "cash_on_cash": "Highest cash-on-cash return",
    "cash_flow": "Highest monthly cash flow",
    "upfront": "Lowest upfront investment",
    "dscr": "Highest DSCR",
    "ltr_return": "Best long-term rental return",
    "str_return": "Best short-term rental return",
    "price_asc": "Lowest price",
    "price_desc": "Highest price",
    "newest": "Newest listings",
}

Pct = Annotated[Num, Field(ge=-100, le=1000)]
Price = Annotated[Num, Field(ge=0, le=100_000_000)]


class SearchFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    zip_codes: list[str] = Field(default_factory=list, max_length=25, description="5-digit ZIP codes")
    cities: list[str] = Field(default_factory=list, max_length=15, description='Cities as "City, ST" (or city names when `state` is set)')
    state: str | None = Field(default=None, description="2-letter state code")
    county: str | None = Field(default=None, max_length=80, description="County name (requires `state`)")
    radius_miles: Annotated[float, Field(gt=0, le=100)] | None = None
    polygon: list[tuple[float, float]] | None = Field(default=None, description="Search area as [longitude, latitude] vertices")
    min_price: Price | None = None
    max_price: Price | None = None
    min_gross_yield: Pct | None = None
    min_net_yield: Pct | None = None
    min_cap_rate: Pct | None = None
    min_cash_on_cash: Pct | None = None
    min_cash_flow: Annotated[Num, Field(ge=-100000, le=1000000)] | None = None
    min_beds: Annotated[int, Field(ge=0, le=20)] | None = None
    max_beds: Annotated[int, Field(ge=0, le=20)] | None = None
    property_types: list[PropertyType] = Field(default_factory=list)
    max_hoa: Price | None = None
    max_days_on_market: Annotated[int, Field(ge=0, le=3650)] | None = None
    min_year_built: Annotated[int, Field(ge=1700, le=2100)] | None = None
    max_year_built: Annotated[int, Field(ge=1700, le=2100)] | None = None
    strategy: Literal["ltr", "str", "both"] = "both"

    @field_validator("zip_codes", mode="before")
    @classmethod
    def _zips(cls, value: object) -> object:
        if isinstance(value, str):
            value = re.split(r"[,\s;]+", value)
        if isinstance(value, list):
            cleaned = []
            for item in value:
                text = str(item).strip()
                if not text:
                    continue
                if not re.fullmatch(r"\d{5}", text):
                    raise ValueError(f"'{text}' is not a 5-digit ZIP code")
                if text not in cleaned:
                    cleaned.append(text)
            return cleaned
        return value

    @field_validator("cities", mode="before")
    @classmethod
    def _cities(cls, value: object) -> object:
        if isinstance(value, str):
            value = [part for part in re.split(r"[;|]+", value)]
        if isinstance(value, list):
            cleaned = []
            for item in value:
                text = re.sub(r"\s+", " ", str(item)).strip(" ,")
                if text and len(text) <= 80 and text not in cleaned:
                    if not re.fullmatch(r"[A-Za-z .'\-]+(,\s*[A-Za-z]{2})?", text):
                        raise ValueError(f"'{text}' is not a valid city (use \"City, ST\")")
                    cleaned.append(text)
            return cleaned
        return value

    @field_validator("state", mode="before")
    @classmethod
    def _state(cls, value: object) -> object:
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        text = str(value).strip().upper()
        if text not in US_STATES:
            raise ValueError("state must be a 2-letter US state code")
        return text

    @field_validator("county", mode="before")
    @classmethod
    def _county(cls, value: object) -> object:
        if isinstance(value, str):
            value = re.sub(r"\s+", " ", value).strip()
            return value or None
        return value

    @model_validator(mode="after")
    def _check(self) -> SearchFilters:
        if self.polygon is not None:
            if not 3 <= len(self.polygon) <= 200:
                raise ValueError("polygon must have between 3 and 200 vertices")
            for lng, lat in self.polygon:
                if not (-180 <= lng <= 180 and -90 <= lat <= 90):
                    raise ValueError("polygon vertices must be [longitude, latitude]")
        if not (self.zip_codes or self.cities or self.state or self.polygon):
            raise ValueError("Provide at least one location: a ZIP code, city, county + state, state, or a drawn area")
        if self.county and not self.state:
            raise ValueError("county searches require a state")
        if self.min_price is not None and self.max_price is not None and self.min_price > self.max_price:
            raise ValueError("min_price cannot be greater than max_price")
        if self.min_beds is not None and self.max_beds is not None and self.min_beds > self.max_beds:
            raise ValueError("min_beds cannot be greater than max_beds")
        if self.min_year_built is not None and self.max_year_built is not None and self.min_year_built > self.max_year_built:
            raise ValueError("min_year_built cannot be later than max_year_built")
        return self


class SearchRunRequest(BaseModel):
    filters: SearchFilters
    defaults: AssumptionOverrides | None = Field(default=None, description="Standing assumptions (financing, expense ratios) applied to every property")  # type: ignore[valid-type]
    weights: ScoreWeights | None = None
    refresh: bool = Field(default=False, description="Ignore cached results and re-query providers")


class StrategySummary(BaseModel):
    available: bool
    monthly_income: Num | None = None
    gross_yield_pct: Num | None = None
    net_yield_pct: Num | None = None
    cap_rate_pct: Num | None = None
    cash_on_cash_pct: Num | None = None
    monthly_cash_flow: Num | None = None
    noi_annual: Num | None = None
    dscr: Num | None = None
    break_even_occupancy_pct: Num | None = None
    total_cash_invested: Num | None = None
    score: Num | None = None
    confidence: ConfidenceLabel = "insufficient"


class PropertyCard(BaseModel):
    id: uuid.UUID
    formatted_address: str
    address_line1: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    county: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    property_type: str | None = None
    bedrooms: Num | None = None
    bathrooms: Num | None = None
    square_feet: int | None = None
    year_built: int | None = None
    price: Num | None = None
    days_on_market: int | None = None
    hoa_fee_monthly: Num | None = None
    image_url: str | None = None
    listing_url: str | None = None
    listing_source: str | None = None
    last_seen_at: datetime | None = None
    is_demo: bool = False
    rent_source: Literal["property_avm", "market_zip", "none"] = "none"
    str_source: Literal["provider", "none"] = "none"
    long_term: StrategySummary
    short_term: StrategySummary
    primary_strategy: Literal["ltr", "str"] | None = None
    recommendation: str
    recommendation_conditional: bool = False
    score: Num | None = None
    confidence: ConfidenceLabel = "insufficient"
    upfront_cash: Num | None = None
    legality_status: str = "unknown"
    legality_label: str = "Unknown / needs verification"
    badges: list[Badge] = []
    price_reduction: PriceReduction | None = None


class JobProgress(BaseModel):
    stage: Literal["queued", "resolving", "fetching_listings", "screening", "rent_estimates", "str_estimates", "ranking", "done"] = "queued"
    message: str = "Queued"
    percent: int = 0
    pages_fetched: int = 0
    listings_found: int = 0
    estimates_done: int = 0
    estimates_total: int = 0


class SearchJob(BaseModel):
    id: str
    status: Literal["queued", "running", "completed", "failed"]
    progress: JobProgress = Field(default_factory=JobProgress)
    partial: bool = False
    partial_reasons: list[str] = []
    warnings: list[str] = []
    error: str | None = None
    result_count: int | None = None
    listings_fetched: int | None = None
    data_mode: str = "demo"
    cached: bool = False
    created_at: datetime
    finished_at: datetime | None = None
    filters: SearchFilters


class ResultSummary(BaseModel):
    total: int
    matched: int
    median_price: Num | None = None
    median_gross_yield_pct: Num | None = None
    median_cap_rate_pct: Num | None = None
    median_cash_flow: Num | None = None
    positive_cash_flow_count: int = 0
    average_score: Num | None = None


class SearchResults(BaseModel):
    job: SearchJob
    items: list[PropertyCard]
    page: int
    page_size: int
    total: int
    total_pages: int
    sort: SortKey
    strategy: Literal["ltr", "str", "both"]
    summary: ResultSummary


class MapPoint(BaseModel):
    id: uuid.UUID
    latitude: float
    longitude: float
    price: Num | None = None
    gross_yield_pct: Num | None = None
    monthly_cash_flow: Num | None = None
    score: Num | None = None
    address: str


class MapResults(BaseModel):
    points: list[MapPoint]
    total: int
