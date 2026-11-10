"""Deterministic investment calculator.

Formulas (all percentages reported ×100):

    gross yield          = annual gross rental income / purchase price
    effective gross inc. = gross income − vacancy loss
    NOI                  = effective gross income − operating expenses
                           (no mortgage, depreciation or income tax)
    cap rate             = NOI / purchase price
    net yield            = NOI / total acquisition basis
    annual debt service  = principal + interest + PMI
    monthly cash flow    = (NOI − annual debt service) / 12
    cash-on-cash         = annual pre-tax cash flow / total cash invested
    DSCR                 = NOI / annual debt service        (n/a for cash purchases)
    total cash invested  = down payment + closing + inspection + renovation
                           + repairs + furnishing + reserves + other
    acquisition basis    = purchase price + the same costs, excluding reserves

See docs/FINANCIAL_MODEL.md for the full specification.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from .inputs import Assumptions
from .money import HUNDRED, ONE, TWELVE, ZERO, clamp, frac, money, pct, ratio
from .mortgage import Loan, build_loan
from .results import CashLine, ExpenseLine, LoanSummary, StrategyResult, Strategy, StrDetail

DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
DAYS_IN_YEAR = Decimal("365")


@dataclass
class YearFactors:
    """Multipliers applied to year-1 assumptions when projecting later years."""

    income: Decimal = ONE  # rent / ADR growth
    expense: Decimal = ONE  # inflation on dollar-denominated costs
    vacancy_shift_pct: Decimal = ZERO  # percentage points added to vacancy


BASE_YEAR = YearFactors()


@dataclass
class Operating:
    """One year of property operations for a strategy, before financing."""

    gross_income: Decimal
    vacancy_loss: Decimal
    effective_gross_income: Decimal
    lines: list[tuple[str, str, Decimal, str]]  # key, label, annual amount, behavior
    str_detail: dict | None = None
    # Inputs for break-even maths
    fixed_costs: Decimal = ZERO
    extras: dict = field(default_factory=dict)

    @property
    def operating_expenses(self) -> Decimal:
        return sum((line[2] for line in self.lines), ZERO)

    @property
    def noi(self) -> Decimal:
        return self.effective_gross_income - self.operating_expenses


# ---------------------------------------------------------------------------
# Shared pieces
# ---------------------------------------------------------------------------


def property_tax_annual(a: Assumptions) -> Decimal:
    if a.fixed.property_tax_annual is not None:
        return a.fixed.property_tax_annual
    return money(a.acquisition.purchase_price * frac(a.fixed.property_tax_rate_pct))


def insurance_annual(a: Assumptions) -> Decimal:
    if a.fixed.insurance_annual is not None:
        return a.fixed.insurance_annual
    return money(a.acquisition.purchase_price * frac(a.fixed.insurance_rate_pct))


def _fixed_lines(a: Assumptions, f: YearFactors) -> list[tuple[str, str, Decimal, str]]:
    lines = [
        ("property_tax", "Property taxes", money(property_tax_annual(a) * f.expense), "fixed"),
        ("insurance", "Property insurance", money(insurance_annual(a) * f.expense), "fixed"),
        ("hoa", "HOA fees", money(a.fixed.hoa_monthly * TWELVE * f.expense), "fixed"),
    ]
    if a.fixed.other_monthly > 0:
        lines.append(("other", "Other recurring expenses", money(a.fixed.other_monthly * TWELVE * f.expense), "fixed"))
    return lines


def build_loan_for(a: Assumptions) -> Loan:
    return build_loan(a.acquisition.purchase_price, a.financing)


def closing_costs(a: Assumptions) -> Decimal:
    return money(a.acquisition.purchase_price * frac(a.acquisition.closing_cost_pct))


def initial_reserves(a: Assumptions, loan: Loan) -> Decimal:
    if a.acquisition.initial_reserves is not None:
        return a.acquisition.initial_reserves
    monthly_carry = (
        loan.monthly_principal_interest
        + loan.monthly_pmi
        + property_tax_annual(a) / TWELVE
        + insurance_annual(a) / TWELVE
        + a.fixed.hoa_monthly
        + a.fixed.other_monthly
    )
    return money(monthly_carry * a.acquisition.reserve_months)


def cash_breakdown(a: Assumptions, loan: Loan, strategy: Strategy) -> list[CashLine]:
    furnishing = a.short_term.furnishing_cost if strategy == "str" else a.long_term.furnishing_cost
    items = [
        ("down_payment", "Down payment", loan.down_payment),
        ("closing_costs", "Closing costs", closing_costs(a)),
        ("inspection", "Inspection", a.acquisition.inspection_cost),
        ("renovation", "Renovation", a.acquisition.renovation_cost),
        ("initial_repairs", "Initial repairs", a.acquisition.initial_repair_budget),
        ("furnishing", "Furnishing", furnishing),
        ("reserves", "Initial cash reserves", initial_reserves(a, loan)),
        ("other", "Other acquisition costs", a.acquisition.other_acquisition_costs),
    ]
    return [CashLine(key=k, label=label, amount=money(v)) for k, label, v in items]


def total_cash_invested(lines: list[CashLine]) -> Decimal:
    return sum((line.amount for line in lines), ZERO)


def acquisition_basis(a: Assumptions, lines: list[CashLine]) -> Decimal:
    """Purchase price plus capitalised acquisition costs (reserves are not basis)."""
    extra = sum((line.amount for line in lines if line.key not in ("down_payment", "reserves")), ZERO)
    return a.acquisition.purchase_price + extra


# ---------------------------------------------------------------------------
# Long-term rental
# ---------------------------------------------------------------------------


def ltr_operating(a: Assumptions, f: YearFactors = BASE_YEAR) -> Operating | None:
    lt = a.long_term
    if lt.monthly_rent is None or lt.monthly_rent <= 0:
        return None

    rent_annual = money(lt.monthly_rent * TWELVE * f.income)
    other_income = money(lt.other_income_monthly * TWELVE * f.income)
    gross = rent_annual + other_income
    vacancy_pct = clamp(lt.vacancy_pct + f.vacancy_shift_pct, ZERO, HUNDRED)
    vacancy_loss = money(rent_annual * frac(vacancy_pct))
    collected_rent = rent_annual - vacancy_loss
    egi = collected_rent + other_income

    lines = _fixed_lines(a, f)
    management = money(collected_rent * frac(lt.management_pct))
    maintenance = money(rent_annual * frac(lt.maintenance_pct))
    capex = money(rent_annual * frac(lt.capex_pct))
    leasing = money(
        lt.monthly_rent * f.income * frac(lt.leasing_fee_pct_of_monthly_rent) * frac(lt.annual_turnover_pct)
    )
    utilities = money(lt.owner_utilities_monthly * TWELVE * f.expense)
    lines += [
        ("management", "Property management", management, "variable"),
        ("maintenance", "Maintenance & repairs", maintenance, "fixed"),
        ("capex", "Capital expenditure reserve", capex, "fixed"),
        ("leasing", "Leasing & turnover", leasing, "fixed"),
    ]
    if utilities > 0:
        lines.append(("utilities", "Owner-paid utilities", utilities, "fixed"))

    fixed_costs = sum((amount for _, _, amount, behavior in lines if behavior == "fixed"), ZERO)
    return Operating(
        gross_income=gross,
        vacancy_loss=vacancy_loss,
        effective_gross_income=egi,
        lines=lines,
        fixed_costs=fixed_costs,
        extras={"rent_annual": rent_annual, "other_income": other_income, "management_frac": frac(lt.management_pct)},
    )


def _ltr_break_even(op: Operating, debt_service: Decimal) -> tuple[Decimal | None, str | None]:
    """Occupancy at which collected rent covers fixed costs, management and debt.

    occupancy = (fixed costs + debt service − other income) / (rent × (1 − mgmt%))
    """
    rent = op.extras["rent_annual"]
    margin = rent * (ONE - op.extras["management_frac"])
    if margin <= 0:
        return None, "Rent after management fees is zero, so the property cannot break even."
    occupancy = (op.fixed_costs + debt_service - op.extras["other_income"]) / margin * HUNDRED
    if occupancy > HUNDRED:
        return pct(occupancy), "Break-even requires more than 100% occupancy at this rent — cash flow is negative even when fully let."
    return pct(max(occupancy, ZERO)), None


# ---------------------------------------------------------------------------
# Short-term rental
# ---------------------------------------------------------------------------


def _seasonal_shares(weights: list[Decimal] | None) -> list[Decimal]:
    """Share of annual booked nights falling in each month (sums to 1)."""
    raw = [Decimal(d) * (w if weights else ONE) for d, w in zip(DAYS_IN_MONTH, weights or [ONE] * 12, strict=True)]
    total = sum(raw, ZERO)
    return [r / total for r in raw]


def str_operating(a: Assumptions, f: YearFactors = BASE_YEAR) -> Operating | None:
    st = a.short_term
    if st.adr is None or st.occupancy_pct is None or st.adr <= 0 or st.occupancy_pct <= 0:
        return None

    available_nights = max(365 - st.unavailable_nights, 0)
    occupancy = clamp(st.occupancy_pct - f.vacancy_shift_pct, ZERO, HUNDRED)

    if st.occupancy_basis == "calendar":
        booked = DAYS_IN_YEAR * frac(occupancy)
        booked = min(booked, Decimal(available_nights))
    else:
        booked = Decimal(available_nights) * frac(occupancy)

    capped = False
    if st.max_rentable_nights is not None and booked > st.max_rentable_nights:
        booked = Decimal(st.max_rentable_nights)
        capped = True
    if booked <= 0:
        return None

    adr = st.adr * f.income
    accommodation = money(adr * booked)
    turnovers = booked / st.avg_stay_nights
    fee_per_stay = ZERO if st.adr_includes_cleaning_fee else st.cleaning_fee_per_stay * f.income
    cleaning_fee_revenue = money(fee_per_stay * turnovers)
    gross = accommodation + cleaning_fee_revenue

    platform = money(gross * frac(st.platform_fee_pct))
    booking = money(gross * frac(st.booking_fee_pct))
    management = money(accommodation * frac(st.management_pct))
    maintenance = money(accommodation * frac(st.maintenance_pct))
    capex = money(accommodation * frac(st.capex_pct))
    cleaning = money(st.cleaning_cost_per_turnover * f.expense * turnovers)
    consumables = money(st.consumables_per_turnover * f.expense * turnovers)
    utilities = money(st.utilities_monthly * TWELVE * f.expense)
    internet = money(st.internet_monthly * TWELVE * f.expense)

    lines = _fixed_lines(a, f)
    lines += [
        ("platform_fees", "Host / platform fees", platform, "variable"),
        ("management", "Property management", management, "variable"),
        ("cleaning", "Cleaning & turnover", cleaning, "variable"),
        ("consumables", "Supplies & consumables", consumables, "variable"),
        ("maintenance", "Maintenance & repairs", maintenance, "variable"),
        ("capex", "Capital expenditure reserve", capex, "variable"),
        ("utilities", "Utilities", utilities, "fixed"),
        ("internet", "Internet", internet, "fixed"),
    ]
    if booking > 0:
        lines.insert(4, ("booking_fees", "Booking / payment fees", booking, "variable"))
    if st.permit_fees_annual > 0:
        lines.append(("permits", "STR permits & licences", money(st.permit_fees_annual * f.expense), "fixed"))
    if st.additional_insurance_annual > 0:
        lines.append(
            ("str_insurance", "Additional STR insurance", money(st.additional_insurance_annual * f.expense), "fixed")
        )

    fixed_costs = sum((amount for _, _, amount, behavior in lines if behavior == "fixed"), ZERO)
    variable_costs = sum((amount for _, _, amount, behavior in lines if behavior == "variable"), ZERO)

    # Contribution margin per booked night, used for break-even occupancy.
    fee_frac = frac(st.platform_fee_pct) + frac(st.booking_fee_pct)
    acc_frac = frac(st.management_pct) + frac(st.maintenance_pct) + frac(st.capex_pct)
    per_stay_net = (
        fee_per_stay * (ONE - fee_frac)
        - st.cleaning_cost_per_turnover * f.expense
        - st.consumables_per_turnover * f.expense
    )
    margin_per_night = adr * (ONE - fee_frac - acc_frac) + per_stay_net / st.avg_stay_nights

    shares = _seasonal_shares(st.seasonality)
    monthly_revenue = [money(gross * s) for s in shares]
    monthly_noi = [money((gross - variable_costs) * s - fixed_costs / TWELVE) for s in shares]

    detail = {
        "adr": money(adr),
        "occupancy_pct": pct(occupancy),
        "occupancy_basis": st.occupancy_basis,
        "available_nights": available_nights,
        "booked_nights": booked.quantize(Decimal("0.1")),
        "calendar_occupancy_pct": pct(booked / DAYS_IN_YEAR * HUNDRED),
        "available_occupancy_pct": pct(booked / Decimal(available_nights) * HUNDRED) if available_nights else pct(ZERO),
        "nights_capped_by_regulation": capped,
        "turnovers": turnovers.quantize(Decimal("0.1")),
        "accommodation_revenue": accommodation,
        "cleaning_fee_revenue": cleaning_fee_revenue,
        "revpar": money(accommodation / DAYS_IN_YEAR),
        "monthly_revenue": monthly_revenue,
        "monthly_net_operating_income": monthly_noi,
    }
    return Operating(
        gross_income=gross,
        vacancy_loss=ZERO,
        effective_gross_income=gross,
        lines=lines,
        str_detail=detail,
        fixed_costs=fixed_costs,
        extras={
            "margin_per_night": margin_per_night,
            "available_nights": Decimal(available_nights),
            "max_nights": Decimal(st.max_rentable_nights) if st.max_rentable_nights is not None else None,
        },
    )


def _str_break_even(op: Operating, debt_service: Decimal) -> tuple[Decimal | None, str | None]:
    """Occupancy (of available nights) at which booking margin covers fixed costs and debt.

    nights = (fixed costs + debt service) / contribution margin per booked night
    """
    margin = op.extras["margin_per_night"]
    available = op.extras["available_nights"]
    if margin <= 0:
        return None, "Each booked night loses money after variable costs, so no occupancy level breaks even."
    if available <= 0:
        return None, "No nights are available to rent."
    nights = (op.fixed_costs + debt_service) / margin
    occupancy = nights / available * HUNDRED
    cap = op.extras["max_nights"]
    if cap is not None and nights > cap:
        return pct(occupancy), f"Break-even needs about {nights.quantize(ONE)} booked nights, above the {cap} night cap."
    if occupancy > HUNDRED:
        return pct(occupancy), "Break-even requires more than 100% of available nights — cash flow is negative even when fully booked."
    return pct(max(occupancy, ZERO)), None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def operating_for(a: Assumptions, strategy: Strategy, f: YearFactors = BASE_YEAR) -> Operating | None:
    return ltr_operating(a, f) if strategy == "ltr" else str_operating(a, f)


def loan_summary(a: Assumptions, loan: Loan | None = None) -> LoanSummary:
    loan = loan or build_loan_for(a)
    first = loan.year(1)
    return LoanSummary(
        is_cash=loan.is_cash,
        down_payment=loan.down_payment,
        loan_amount=loan.loan_amount,
        interest_rate_pct=a.financing.interest_rate_pct,
        loan_term_years=a.financing.loan_term_years,
        monthly_principal_interest=loan.monthly_principal_interest,
        monthly_pmi=loan.monthly_pmi,
        pmi_months=loan.pmi_months,
        annual_debt_service=money(first.debt_service),
        first_year_principal=money(first.principal_paid),
        first_year_interest=money(first.interest_paid),
    )


_UNAVAILABLE = {
    "ltr": "No reliable long-term rent estimate is available. Enter a monthly rent to model this strategy.",
    "str": "No short-term rental revenue estimate is available. Enter an average daily rate and occupancy to model this strategy.",
}


def analyze_strategy(a: Assumptions, strategy: Strategy, loan: Loan | None = None) -> StrategyResult:
    """Year-one analysis of one strategy under the given assumptions."""
    op = operating_for(a, strategy)
    if op is None:
        return StrategyResult(strategy=strategy, available=False, unavailable_reason=_UNAVAILABLE[strategy])

    loan = loan or build_loan_for(a)
    price = a.acquisition.purchase_price
    cash_lines = cash_breakdown(a, loan, strategy)
    cash_invested = total_cash_invested(cash_lines)
    basis = acquisition_basis(a, cash_lines)

    noi = op.noi
    debt_service = money(loan.first_year_debt_service)
    cash_flow = noi - debt_service

    if strategy == "ltr":
        break_even, note = _ltr_break_even(op, debt_service)
    else:
        break_even, note = _str_break_even(op, debt_service)

    expenses = [
        ExpenseLine(key=k, label=label, annual=amount, monthly=money(amount / TWELVE), behavior=behavior)  # type: ignore[arg-type]
        for k, label, amount, behavior in op.lines
        if amount != 0 or k in ("property_tax", "insurance", "hoa")
    ]
    opex = op.operating_expenses

    return StrategyResult(
        strategy=strategy,
        available=True,
        gross_annual_income=op.gross_income,
        gross_monthly_income=money(op.gross_income / TWELVE),
        gross_yield_pct=pct(op.gross_income / price * HUNDRED),
        vacancy_loss=op.vacancy_loss,
        effective_gross_income=op.effective_gross_income,
        expenses=expenses,
        operating_expenses_annual=opex,
        expense_ratio_pct=pct(opex / op.effective_gross_income * HUNDRED) if op.effective_gross_income > 0 else None,
        noi_annual=money(noi),
        cap_rate_pct=pct(noi / price * HUNDRED),
        net_yield_pct=pct(noi / basis * HUNDRED),
        annual_debt_service=debt_service,
        annual_cash_flow=money(cash_flow),
        monthly_cash_flow=money(cash_flow / TWELVE),
        cash_on_cash_pct=pct(cash_flow / cash_invested * HUNDRED) if cash_invested > 0 else None,
        dscr=ratio(noi / debt_service) if debt_service > 0 else None,
        break_even_occupancy_pct=break_even,
        break_even_note=note,
        total_cash_invested=money(cash_invested),
        acquisition_basis=money(basis),
        cash_breakdown=cash_lines,
        str_detail=StrDetail(**op.str_detail) if op.str_detail else None,
    )


def analyze_both(a: Assumptions) -> tuple[StrategyResult, StrategyResult, LoanSummary]:
    loan = build_loan_for(a)
    return analyze_strategy(a, "ltr", loan), analyze_strategy(a, "str", loan), loan_summary(a, loan)
