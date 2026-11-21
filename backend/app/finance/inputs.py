"""Input (assumption) models for the financial engine.

These are plain validated data containers. The engine is pure: the same inputs
always produce the same outputs, and nothing here performs I/O.

Percent fields are expressed as percents (``7.25`` means 7.25%).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, model_validator

# Decimals are validated exactly and emitted as JSON numbers.
Dec = Annotated[Decimal, PlainSerializer(lambda v: None if v is None else float(v), return_type=float, when_used="json")]
Money = Annotated[Dec, Field(ge=0, max_digits=14, decimal_places=2)]
Pct = Annotated[Dec, Field(ge=0, le=100)]
GrowthPct = Annotated[Dec, Field(ge=-50, le=50)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class Financing(_Model):
    """Loan terms. ``down_payment_pct = 100`` models an all-cash purchase."""

    down_payment_pct: Pct = Decimal("25")
    interest_rate_pct: Annotated[Dec, Field(ge=0, le=30)] = Decimal("7.0")
    loan_term_years: Annotated[int, Field(ge=1, le=40)] = 30
    # Annual PMI as a percent of the original loan amount; charged only while
    # the loan-to-value ratio is above ``pmi_removal_ltv_pct``.
    pmi_annual_rate_pct: Annotated[Dec, Field(ge=0, le=5)] = Decimal("0.75")
    pmi_required_below_down_pct: Pct = Decimal("20")
    pmi_removal_ltv_pct: Pct = Decimal("78")

    @property
    def is_cash(self) -> bool:
        return self.down_payment_pct >= 100


class Acquisition(_Model):
    purchase_price: Annotated[Dec, Field(gt=0, max_digits=14, decimal_places=2)]
    closing_cost_pct: Annotated[Dec, Field(ge=0, le=20)] = Decimal("3")
    inspection_cost: Money = Decimal("500")
    renovation_cost: Money = Decimal("0")
    initial_repair_budget: Money = Decimal("0")
    other_acquisition_costs: Money = Decimal("0")
    # Reserves default to N months of fixed carrying costs (debt service, taxes,
    # insurance, HOA). Provide ``initial_reserves`` to override with a dollar amount.
    reserve_months: Annotated[Dec, Field(ge=0, le=36)] = Decimal("3")
    initial_reserves: Money | None = None


class FixedExpenses(_Model):
    """Ownership costs that do not depend on the rental strategy."""

    # When ``*_annual`` is None the value is estimated as rate × purchase price.
    property_tax_annual: Money | None = None
    property_tax_rate_pct: Annotated[Dec, Field(ge=0, le=10)] = Decimal("1.1")
    insurance_annual: Money | None = None
    insurance_rate_pct: Annotated[Dec, Field(ge=0, le=10)] = Decimal("0.5")
    hoa_monthly: Money = Decimal("0")
    other_monthly: Money = Decimal("0")


class LongTermRental(_Model):
    # None means "no reliable rent estimate" — the LTR scenario is then reported
    # as unavailable instead of being computed from an invented number.
    monthly_rent: Money | None = None
    other_income_monthly: Money = Decimal("0")
    vacancy_pct: Pct = Decimal("6")
    management_pct: Pct = Decimal("8")  # of collected rent
    maintenance_pct: Pct = Decimal("8")  # of gross potential rent
    capex_pct: Pct = Decimal("5")  # of gross potential rent
    leasing_fee_pct_of_monthly_rent: Annotated[Dec, Field(ge=0, le=200)] = Decimal("50")
    annual_turnover_pct: Pct = Decimal("35")
    owner_utilities_monthly: Money = Decimal("0")
    furnishing_cost: Money = Decimal("0")


class ShortTermRental(_Model):
    # None for either value means "no reliable STR estimate".
    adr: Money | None = None
    occupancy_pct: Pct | None = None
    # "available": occupancy is booked nights / nights the unit is offered.
    # "calendar":  occupancy is booked nights / 365 (already net of blocked nights).
    occupancy_basis: Literal["available", "calendar"] = "available"
    unavailable_nights: Annotated[int, Field(ge=0, le=365)] = 14
    # Regulatory or HOA cap on rentable nights per year (e.g. a 90-night rule).
    max_rentable_nights: Annotated[int, Field(ge=0, le=365)] | None = None
    avg_stay_nights: Annotated[Dec, Field(gt=0, le=365)] = Decimal("3.5")
    # Cleaning fee charged to the guest per stay. Set ``adr_includes_cleaning_fee``
    # when the ADR source already bundles cleaning fees (AirDNA does) so the fee
    # is not counted twice as revenue.
    cleaning_fee_per_stay: Money = Decimal("110")
    adr_includes_cleaning_fee: bool = False
    cleaning_cost_per_turnover: Money = Decimal("110")
    platform_fee_pct: Pct = Decimal("3")  # host service fee, on all booking revenue
    booking_fee_pct: Pct = Decimal("0")  # payment processing / channel manager
    management_pct: Pct = Decimal("20")  # of accommodation revenue
    maintenance_pct: Pct = Decimal("5")  # of accommodation revenue
    capex_pct: Pct = Decimal("5")  # of accommodation revenue
    utilities_monthly: Money = Decimal("260")
    internet_monthly: Money = Decimal("70")
    consumables_per_turnover: Money = Decimal("18")
    permit_fees_annual: Money = Decimal("0")
    additional_insurance_annual: Money = Decimal("0")
    furnishing_cost: Money = Decimal("0")
    # Twelve relative demand weights (Jan..Dec). None means a flat year.
    seasonality: list[Annotated[Dec, Field(ge=0, le=10)]] | None = None

    @model_validator(mode="after")
    def _check_seasonality(self) -> ShortTermRental:
        if self.seasonality is not None:
            if len(self.seasonality) != 12:
                raise ValueError("seasonality must contain exactly 12 monthly weights")
            if sum(self.seasonality) <= 0:
                raise ValueError("seasonality weights must not all be zero")
        return self


class CapitalImprovement(_Model):
    year: Annotated[int, Field(ge=1, le=40)]
    amount: Money
    label: str = Field(default="Capital improvement", max_length=80)


class Forecast(_Model):
    rent_growth_pct: GrowthPct = Decimal("3")
    appreciation_pct: GrowthPct = Decimal("3")
    expense_inflation_pct: GrowthPct = Decimal("2.5")
    selling_cost_pct: Annotated[Dec, Field(ge=0, le=20)] = Decimal("6")
    # Change in vacancy (LTR, percentage points) or occupancy shortfall (STR)
    # applied each year after year 1. Positive = conditions get worse.
    vacancy_change_pct_per_year: Annotated[Dec, Field(ge=-5, le=5)] = Decimal("0")
    capital_improvements: list[CapitalImprovement] = Field(default_factory=list, max_length=40)
    horizon_years: Annotated[int, Field(ge=1, le=40)] = 30


class Assumptions(_Model):
    acquisition: Acquisition
    financing: Financing = Field(default_factory=Financing)
    fixed: FixedExpenses = Field(default_factory=FixedExpenses)
    long_term: LongTermRental = Field(default_factory=LongTermRental)
    short_term: ShortTermRental = Field(default_factory=ShortTermRental)
    forecast: Forecast = Field(default_factory=Forecast)
