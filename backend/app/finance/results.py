"""Output models for the financial engine."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, PlainSerializer

# Decimals are computed exactly and rounded once, then serialized as JSON
# numbers (cents and basis points are exactly representable for display).
Num = Annotated[Decimal, PlainSerializer(lambda v: float(v), return_type=float, when_used="json")]

Strategy = Literal["ltr", "str"]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExpenseLine(_Out):
    key: str
    label: str
    annual: Num
    monthly: Num
    # fixed: independent of occupancy; variable: scales with income/bookings
    behavior: Literal["fixed", "variable"]


class CashLine(_Out):
    key: str
    label: str
    amount: Num


class LoanSummary(_Out):
    is_cash: bool
    down_payment: Num
    loan_amount: Num
    interest_rate_pct: Num
    loan_term_years: int
    monthly_principal_interest: Num
    monthly_pmi: Num
    pmi_months: int
    annual_debt_service: Num
    first_year_principal: Num
    first_year_interest: Num


class StrDetail(_Out):
    adr: Num
    occupancy_pct: Num  # as entered
    occupancy_basis: Literal["available", "calendar"]
    available_nights: int
    booked_nights: Num
    calendar_occupancy_pct: Num  # booked nights / 365
    available_occupancy_pct: Num  # booked nights / available nights
    nights_capped_by_regulation: bool
    turnovers: Num
    accommodation_revenue: Num
    cleaning_fee_revenue: Num
    revpar: Num  # accommodation revenue per calendar night
    monthly_revenue: list[Num]  # Jan..Dec gross revenue
    monthly_net_operating_income: list[Num]


class StrategyResult(_Out):
    strategy: Strategy
    available: bool
    unavailable_reason: str | None = None

    # --- Gross (before any costs) ---
    gross_annual_income: Num | None = None
    gross_monthly_income: Num | None = None
    gross_yield_pct: Num | None = None

    # --- Operating (before financing) ---
    vacancy_loss: Num | None = None
    effective_gross_income: Num | None = None
    expenses: list[ExpenseLine] = []
    operating_expenses_annual: Num | None = None
    expense_ratio_pct: Num | None = None
    noi_annual: Num | None = None
    cap_rate_pct: Num | None = None
    net_yield_pct: Num | None = None

    # --- Leveraged (after financing) ---
    annual_debt_service: Num | None = None
    annual_cash_flow: Num | None = None
    monthly_cash_flow: Num | None = None
    cash_on_cash_pct: Num | None = None
    dscr: Num | None = None  # None => not applicable (cash purchase)
    break_even_occupancy_pct: Num | None = None
    break_even_note: str | None = None

    # --- Capital ---
    total_cash_invested: Num | None = None
    acquisition_basis: Num | None = None
    cash_breakdown: list[CashLine] = []

    str_detail: StrDetail | None = None


class ForecastYear(_Out):
    year: int
    gross_income: Num
    operating_expenses: Num
    noi: Num
    debt_service: Num
    capital_improvements: Num
    cash_flow: Num
    cumulative_cash_flow: Num
    principal_paid: Num
    cumulative_principal_paid: Num
    loan_balance: Num
    property_value: Num
    equity: Num
    net_sale_proceeds: Num  # if sold at end of this year, after selling costs & payoff
    total_profit: Num  # cumulative cash flow + net sale proceeds + reserves − cash invested


class HorizonSummary(_Out):
    years: int
    cumulative_cash_flow: Num
    principal_reduction: Num
    appreciation: Num
    selling_costs: Num
    loan_balance: Num
    property_value: Num
    equity: Num
    net_sale_proceeds: Num
    total_profit: Num
    total_return_pct: Num | None
    equity_multiple: Num | None
    irr_pct: Num | None


class ForecastResult(_Out):
    strategy: Strategy
    available: bool
    initial_cash_invested: Num | None = None
    years: list[ForecastYear] = []
    horizons: list[HorizonSummary] = []
    assumptions_note: str = (
        "Projection, not a guarantee. Rent, appreciation and expense growth are user assumptions applied "
        "at constant annual rates; actual results will differ."
    )


class ScenarioResult(_Out):
    name: Literal["conservative", "base", "optimistic"]
    changes: list[str]
    result: StrategyResult
    ten_year_total_profit: Num | None = None
    ten_year_irr_pct: Num | None = None


class SensitivityRow(_Out):
    label: str
    input_value: Num
    monthly_cash_flow: Num | None
    cash_on_cash_pct: Num | None
    cap_rate_pct: Num | None
    dscr: Num | None
    is_base: bool = False


class SensitivityTable(_Out):
    variable: Literal["purchase_price", "interest_rate", "rent", "occupancy"]
    label: str
    unit: Literal["currency", "percent"]
    rows: list[SensitivityRow]


class SensitivityGrid(_Out):
    """Monthly cash flow for purchase price (rows) × interest rate (columns)."""

    row_label: str
    column_label: str
    rows: list[Num]
    columns: list[Num]
    values: list[list[Num | None]]


class SensitivityResult(_Out):
    strategy: Strategy
    tables: list[SensitivityTable]
    price_rate_grid: SensitivityGrid | None = None


class FinancingScenarioResult(_Out):
    key: str
    label: str
    down_payment_pct: Num
    interest_rate_pct: Num
    loan_term_years: int
    is_cash: bool
    upfront_cash: Num
    monthly_payment: Num  # principal + interest + PMI
    long_term: StrategyResult
    short_term: StrategyResult
    ltr_ten_year_profit: Num | None = None
    ltr_ten_year_irr_pct: Num | None = None
    ltr_thirty_year_profit: Num | None = None
    str_ten_year_profit: Num | None = None
    str_ten_year_irr_pct: Num | None = None
    str_thirty_year_profit: Num | None = None
