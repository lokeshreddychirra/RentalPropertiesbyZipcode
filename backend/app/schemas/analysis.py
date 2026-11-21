"""Request / response schemas for analysis endpoints."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

from app.finance.inputs import Assumptions
from app.finance.quality import ConfidenceLabel, Legality, QualityAssessment
from app.finance.results import (
    FinancingScenarioResult,
    ForecastResult,
    LoanSummary,
    Num,
    ScenarioResult,
    SensitivityResult,
    StrategyResult,
)
from app.finance.scoring import InvestmentScore, Recommendation, ScoreWeights

Provenance = Literal["verified", "estimated", "default", "user", "unavailable"]
Include = Literal["forecast", "scenarios", "sensitivity", "financing"]


_PARTIALS: dict[type[BaseModel], type[BaseModel]] = {}


def _partial(model: type[BaseModel]) -> type[BaseModel]:
    """A copy of ``model`` where every field is optional (for override payloads).

    Field constraints (ge / le / max_digits …) are preserved, so overrides are
    validated as strictly as full assumptions.
    """
    if model in _PARTIALS:
        return _PARTIALS[model]
    fields: dict[str, Any] = {}
    for field_name, info in model.model_fields.items():
        annotation: Any = info.annotation
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            annotation = _partial(annotation) | None
        else:
            annotation = annotation | None
            if info.metadata:
                annotation = Annotated[annotation, *info.metadata]
        fields[field_name] = (annotation, None)
    partial = create_model(f"{model.__name__}Overrides", __config__=ConfigDict(extra="forbid"), **fields)
    _PARTIALS[model] = partial
    return partial


AssumptionOverrides = _partial(Assumptions)
AssumptionOverrides.__doc__ = (
    "Partial assumptions. Only the fields you send are overridden (and marked as user-entered); "
    "everything else comes from listing data, provider estimates or documented defaults."
)


class LegalityInfo(BaseModel):
    status: Legality = "unknown"
    verified: bool = False
    label: str = "Unknown / needs verification"
    summary: str | None = None
    source_url: str | None = None
    verified_at: date | None = None
    max_nights_per_year: int | None = None
    jurisdiction: str | None = None


class Badge(BaseModel):
    key: str
    label: str
    tone: Literal["positive", "warning", "negative", "neutral"]
    detail: str


class RentInfo(BaseModel):
    rent: Num
    rent_low: Num | None = None
    rent_high: Num | None = None
    source: Literal["property_avm", "market_zip"]
    provider: str
    comp_count: int = 0
    market_sample: int = 0
    fetched_at: datetime


class StrInfo(BaseModel):
    adr: Num
    occupancy_pct: Num
    occupancy_basis: Literal["available", "calendar"] = "available"
    annual_revenue: Num | None = None
    cleaning_fee: Num | None = None
    adr_includes_cleaning_fee: bool = False
    avg_stay_nights: Num | None = None
    seasonality: list[Num] | None = None
    level: Literal["property", "market"] = "property"
    provider: str
    comp_count: int = 0
    fetched_at: datetime


class PriceReduction(BaseModel):
    previous_price: Num
    current_price: Num
    changed_on: date
    percent: Num


class PropertyContext(BaseModel):
    """Everything the analysis needs to know about one property."""

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
    status: str = "unknown"
    days_on_market: int | None = None
    listed_date: date | None = None
    hoa_fee_monthly: Num | None = None  # None = not reported
    property_tax_annual: Num | None = None
    property_tax_source: str | None = None
    listing_url: str | None = None
    image_url: str | None = None
    image_count: int = 0
    listing_source: str | None = None
    listing_sources: list[str] = []
    last_seen_at: datetime | None = None
    is_demo: bool = False
    price_reduction: PriceReduction | None = None
    value_estimate: Num | None = None
    rent: RentInfo | None = None
    short_term: StrInfo | None = None
    legality: LegalityInfo = Field(default_factory=LegalityInfo)


class AnalysisRequest(BaseModel):
    property_id: uuid.UUID | None = Field(default=None, description="Analyse a stored property. Omit to analyse ad-hoc assumptions.")
    overrides: AssumptionOverrides | None = Field(default=None, description="Property-specific values entered by the user.")  # type: ignore[valid-type]
    defaults: AssumptionOverrides | None = Field(default=None, description="The user's standing default assumptions (financing, expense ratios, growth rates).")  # type: ignore[valid-type]
    weights: ScoreWeights | None = None
    include: list[Include] = Field(default_factory=list)
    custom_financing: list[CustomFinancing] = Field(default_factory=list, max_length=5)


class CustomFinancing(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    down_payment_pct: Decimal = Field(ge=0, le=100)
    interest_rate_pct: Decimal = Field(ge=0, le=30)
    loan_term_years: int = Field(ge=1, le=40)


class PropertyAnalysis(BaseModel):
    property_id: uuid.UUID | None
    assumptions: Assumptions
    provenance: dict[str, Provenance]
    loan: LoanSummary
    long_term: StrategyResult
    short_term: StrategyResult
    quality_ltr: QualityAssessment
    quality_str: QualityAssessment
    score_ltr: InvestmentScore
    score_str: InvestmentScore
    recommendation: Recommendation
    primary_strategy: Literal["ltr", "str"] | None
    overall_score: Num | None
    confidence: ConfidenceLabel
    legality: LegalityInfo
    badges: list[Badge]
    forecast_ltr: ForecastResult | None = None
    forecast_str: ForecastResult | None = None
    scenarios_ltr: list[ScenarioResult] | None = None
    scenarios_str: list[ScenarioResult] | None = None
    sensitivity_ltr: SensitivityResult | None = None
    sensitivity_str: SensitivityResult | None = None
    financing: list[FinancingScenarioResult] | None = None
    is_demo: bool = False


AnalysisRequest.model_rebuild()
