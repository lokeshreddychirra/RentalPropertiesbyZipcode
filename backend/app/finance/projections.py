"""Multi-year forecasts, scenario analysis, sensitivity tables and financing comparisons.

Everything here is built on :mod:`app.finance.engine`; no formula is duplicated.
"""

from __future__ import annotations

from decimal import Decimal

from .engine import (
    YearFactors,
    analyze_strategy,
    build_loan_for,
    cash_breakdown,
    operating_for,
    total_cash_invested,
)
from .inputs import Assumptions, Financing
from .money import HUNDRED, ONE, ZERO, clamp, frac, money, pct, ratio
from .mortgage import Loan
from .results import (
    FinancingScenarioResult,
    ForecastResult,
    ForecastYear,
    HorizonSummary,
    ScenarioResult,
    SensitivityGrid,
    SensitivityResult,
    SensitivityRow,
    SensitivityTable,
    Strategy,
)

HORIZONS = (1, 5, 10, 15, 30)


# ---------------------------------------------------------------------------
# IRR
# ---------------------------------------------------------------------------


def irr(cash_flows: list[Decimal]) -> Decimal | None:
    """Annual internal rate of return by bisection. ``cash_flows[0]`` is at t=0.

    Returns None when the flows never change sign (no meaningful IRR).
    """
    if not cash_flows or not (any(c < 0 for c in cash_flows) and any(c > 0 for c in cash_flows)):
        return None

    def npv(rate: Decimal) -> Decimal:
        total = ZERO
        factor = ONE
        base = ONE + rate
        for cf in cash_flows:
            total += cf / factor
            factor *= base
        return total

    low, high = Decimal("-0.95"), Decimal("5")
    f_low, f_high = npv(low), npv(high)
    if f_low * f_high > 0:
        return None
    for _ in range(80):
        mid = (low + high) / 2
        f_mid = npv(mid)
        if abs(f_mid) < Decimal("0.005"):
            break
        if f_low * f_mid <= 0:
            high = mid
        else:
            low, f_low = mid, f_mid
    return pct((low + high) / 2 * HUNDRED)


# ---------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------


def forecast(a: Assumptions, strategy: Strategy, loan: Loan | None = None) -> ForecastResult:
    """Year-by-year projection.

    * Income grows at ``rent_growth_pct``; dollar-denominated costs at
      ``expense_inflation_pct``; percentage-based costs follow income.
    * Value grows at ``appreciation_pct`` from the purchase price (no value is
      credited for renovations or capital improvements).
    * "If sold" figures deduct selling costs and the remaining loan balance, and
      release the initial reserves back to the investor.
    """
    if operating_for(a, strategy) is None:
        return ForecastResult(strategy=strategy, available=False)

    loan = loan or build_loan_for(a)
    fc = a.forecast
    price = a.acquisition.purchase_price
    cash_lines = cash_breakdown(a, loan, strategy)
    invested = total_cash_invested(cash_lines)
    reserves = next((line.amount for line in cash_lines if line.key == "reserves"), ZERO)

    income_growth = ONE + frac(fc.rent_growth_pct)
    expense_growth = ONE + frac(fc.expense_inflation_pct)
    value_growth = ONE + frac(fc.appreciation_pct)
    improvements: dict[int, Decimal] = {}
    for item in fc.capital_improvements:
        improvements[item.year] = improvements.get(item.year, ZERO) + item.amount

    years: list[ForecastYear] = []
    cumulative_cf = ZERO
    cumulative_principal = ZERO
    flows: list[Decimal] = [-invested]
    horizons: list[HorizonSummary] = []
    value = price

    for year in range(1, fc.horizon_years + 1):
        factors = YearFactors(
            income=income_growth ** (year - 1),
            expense=expense_growth ** (year - 1),
            vacancy_shift_pct=fc.vacancy_change_pct_per_year * (year - 1),
        )
        op = operating_for(a, strategy, factors)
        if op is None:  # occupancy drifted to zero under the user's assumptions
            gross = opex = noi = ZERO
        else:
            gross, opex, noi = op.gross_income, op.operating_expenses, op.noi

        loan_year = loan.year(year)
        debt_service = money(loan_year.debt_service)
        improvement = improvements.get(year, ZERO)
        cash_flow = money(noi - debt_service - improvement)
        cumulative_cf += cash_flow
        cumulative_principal += loan_year.principal_paid
        balance = loan.balance_after_year(year)
        value = money(price * value_growth**year)
        selling_costs = money(value * frac(fc.selling_cost_pct))
        net_sale = value - selling_costs - balance
        total_profit = cumulative_cf + net_sale + reserves - invested

        years.append(
            ForecastYear(
                year=year,
                gross_income=money(gross),
                operating_expenses=money(opex),
                noi=money(noi),
                debt_service=debt_service,
                capital_improvements=money(improvement),
                cash_flow=cash_flow,
                cumulative_cash_flow=money(cumulative_cf),
                principal_paid=money(loan_year.principal_paid),
                cumulative_principal_paid=money(cumulative_principal),
                loan_balance=money(balance),
                property_value=value,
                equity=money(value - balance),
                net_sale_proceeds=money(net_sale),
                total_profit=money(total_profit),
            )
        )

        if year in HORIZONS:
            exit_flows = flows + [cash_flow + net_sale + reserves]
            horizons.append(
                HorizonSummary(
                    years=year,
                    cumulative_cash_flow=money(cumulative_cf),
                    principal_reduction=money(cumulative_principal),
                    appreciation=money(value - price),
                    selling_costs=selling_costs,
                    loan_balance=money(balance),
                    property_value=value,
                    equity=money(value - balance),
                    net_sale_proceeds=money(net_sale),
                    total_profit=money(total_profit),
                    total_return_pct=pct(total_profit / invested * HUNDRED) if invested > 0 else None,
                    equity_multiple=ratio((cumulative_cf + net_sale + reserves) / invested) if invested > 0 else None,
                    irr_pct=irr(exit_flows),
                )
            )
        flows.append(cash_flow)

    return ForecastResult(
        strategy=strategy,
        available=True,
        initial_cash_invested=money(invested),
        years=years,
        horizons=horizons,
    )


def _horizon(result: ForecastResult, years: int) -> HorizonSummary | None:
    return next((h for h in result.horizons if h.years == years), None)


# ---------------------------------------------------------------------------
# Scenario analysis (conservative / base / optimistic)
# ---------------------------------------------------------------------------


def _seasonal_haircut(weights: list[Decimal] | None, low_season_factor: Decimal) -> Decimal:
    """Occupancy multiplier from weakening every below-average month by ``low_season_factor``."""
    if not weights:
        return ONE
    average = sum(weights, ZERO) / len(weights)
    adjusted = [w * low_season_factor if w < average else w for w in weights]
    return sum(adjusted, ZERO) / sum(weights, ZERO)


def scenario_assumptions(a: Assumptions, strategy: Strategy, name: str) -> tuple[Assumptions, list[str]]:
    """Return the assumption set and human-readable list of changes for a scenario."""
    if name == "base":
        return a, ["Assumptions exactly as entered"]

    b = a.model_copy(deep=True)
    conservative = name == "conservative"
    changes: list[str] = []

    if strategy == "ltr":
        lt = b.long_term
        if lt.monthly_rent is not None:
            factor = Decimal("0.92") if conservative else Decimal("1.05")
            lt.monthly_rent = money(lt.monthly_rent * factor)
            changes.append(f"Rent {'−8%' if conservative else '+5%'}")
        shift = Decimal("4") if conservative else Decimal("-2")
        lt.vacancy_pct = clamp(lt.vacancy_pct + shift, Decimal("2"), HUNDRED)
        changes.append(f"Vacancy {'+4' if conservative else '−2'} pts (to {lt.vacancy_pct}%)")
        lt.maintenance_pct = clamp(lt.maintenance_pct * (Decimal("1.25") if conservative else Decimal("0.9")), ZERO, HUNDRED)
        changes.append(f"Repairs & maintenance {'+25%' if conservative else '−10%'}")
        if conservative:
            lt.management_pct = clamp(lt.management_pct + Decimal("2"), ZERO, HUNDRED)
            changes.append("Property management +2 pts")
    else:
        st = b.short_term
        if st.adr is not None:
            st.adr = money(st.adr * (Decimal("0.88") if conservative else Decimal("1.07")))
            changes.append(f"Average daily rate {'−12%' if conservative else '+7%'}")
        if st.occupancy_pct is not None:
            seasonal = _seasonal_haircut(st.seasonality, Decimal("0.85") if conservative else Decimal("1.05"))
            factor = (Decimal("0.85") if conservative else Decimal("1.08")) * seasonal
            st.occupancy_pct = pct(clamp(st.occupancy_pct * factor, ZERO, Decimal("95")))
            changes.append(f"Occupancy {'−15%' if conservative else '+8%'} (to {st.occupancy_pct}%)")
            if seasonal != ONE:
                changes.append(f"Low-season demand {'15% weaker' if conservative else '5% stronger'}")
        if conservative:
            st.platform_fee_pct = clamp(st.platform_fee_pct + Decimal("2"), ZERO, HUNDRED)
            changes.append("Booking / platform fees +2 pts")
        st.cleaning_cost_per_turnover = money(
            st.cleaning_cost_per_turnover * (Decimal("1.15") if conservative else Decimal("0.95"))
        )
        changes.append(f"Cleaning costs {'+15%' if conservative else '−5%'}")

    b.forecast.expense_inflation_pct = b.forecast.expense_inflation_pct + (
        Decimal("1") if conservative else Decimal("-0.5")
    )
    changes.append(f"Expense inflation {'+1' if conservative else '−0.5'} pt")
    return b, changes


def scenarios(a: Assumptions, strategy: Strategy) -> list[ScenarioResult]:
    out: list[ScenarioResult] = []
    for name in ("conservative", "base", "optimistic"):
        variant, changes = scenario_assumptions(a, strategy, name)
        loan = build_loan_for(variant)
        result = analyze_strategy(variant, strategy, loan)
        ten = _horizon(forecast(_with_horizon(variant, 10), strategy, loan), 10) if result.available else None
        out.append(
            ScenarioResult(
                name=name,  # type: ignore[arg-type]
                changes=changes,
                result=result,
                ten_year_total_profit=ten.total_profit if ten else None,
                ten_year_irr_pct=ten.irr_pct if ten else None,
            )
        )
    return out


def _with_horizon(a: Assumptions, years: int) -> Assumptions:
    if a.forecast.horizon_years == years:
        return a
    b = a.model_copy(deep=True)
    b.forecast.horizon_years = years
    return b


# ---------------------------------------------------------------------------
# Sensitivity
# ---------------------------------------------------------------------------

_PCT_STEPS = (Decimal("-20"), Decimal("-10"), Decimal("-5"), ZERO, Decimal("5"), Decimal("10"), Decimal("20"))
_RATE_STEPS = (Decimal("-2"), Decimal("-1"), Decimal("-0.5"), ZERO, Decimal("0.5"), Decimal("1"), Decimal("2"))
_OCC_STEPS = (Decimal("-15"), Decimal("-10"), Decimal("-5"), ZERO, Decimal("5"), Decimal("10"))


def _row(label: str, value: Decimal, variant: Assumptions, strategy: Strategy, is_base: bool) -> SensitivityRow:
    r = analyze_strategy(variant, strategy)
    return SensitivityRow(
        label=label,
        input_value=value,
        monthly_cash_flow=r.monthly_cash_flow,
        cash_on_cash_pct=r.cash_on_cash_pct,
        cap_rate_pct=r.cap_rate_pct,
        dscr=r.dscr,
        is_base=is_base,
    )


def _signed(step: Decimal, suffix: str) -> str:
    if step == 0:
        return "Base"
    return f"{'+' if step > 0 else '−'}{abs(step).normalize():f}{suffix}"


def _vary_price(a: Assumptions, step_pct: Decimal) -> Assumptions:
    b = a.model_copy(deep=True)
    b.acquisition.purchase_price = money(a.acquisition.purchase_price * (ONE + frac(step_pct)))
    return b


def _vary_rate(a: Assumptions, step_pts: Decimal) -> Assumptions:
    b = a.model_copy(deep=True)
    b.financing.interest_rate_pct = max(a.financing.interest_rate_pct + step_pts, ZERO)
    return b


def sensitivity(a: Assumptions, strategy: Strategy) -> SensitivityResult:
    """One-at-a-time sensitivity of year-one returns to price, rate, rent and occupancy."""
    if operating_for(a, strategy) is None:
        return SensitivityResult(strategy=strategy, tables=[])

    tables: list[SensitivityTable] = []

    rows = [
        _row(_signed(s, "%"), money(a.acquisition.purchase_price * (ONE + frac(s))), _vary_price(a, s), strategy, s == 0)
        for s in _PCT_STEPS
    ]
    tables.append(SensitivityTable(variable="purchase_price", label="Purchase price", unit="currency", rows=rows))

    if not a.financing.is_cash:
        rows = [
            _row(_signed(s, " pts"), max(a.financing.interest_rate_pct + s, ZERO), _vary_rate(a, s), strategy, s == 0)
            for s in _RATE_STEPS
        ]
        tables.append(SensitivityTable(variable="interest_rate", label="Mortgage interest rate", unit="percent", rows=rows))

    rows = []
    for s in _PCT_STEPS:
        b = a.model_copy(deep=True)
        if strategy == "ltr":
            b.long_term.monthly_rent = money(a.long_term.monthly_rent * (ONE + frac(s)))  # type: ignore[operator]
            value = b.long_term.monthly_rent
        else:
            b.short_term.adr = money(a.short_term.adr * (ONE + frac(s)))  # type: ignore[operator]
            value = b.short_term.adr
        rows.append(_row(_signed(s, "%"), value, b, strategy, s == 0))
    tables.append(
        SensitivityTable(
            variable="rent",
            label="Monthly rent" if strategy == "ltr" else "Average daily rate",
            unit="currency",
            rows=rows,
        )
    )

    rows = []
    for s in _OCC_STEPS:
        b = a.model_copy(deep=True)
        if strategy == "ltr":
            occupancy = clamp(HUNDRED - a.long_term.vacancy_pct + s, ZERO, HUNDRED)
            b.long_term.vacancy_pct = HUNDRED - occupancy
        else:
            occupancy = clamp(a.short_term.occupancy_pct + s, Decimal("1"), HUNDRED)  # type: ignore[operator]
            b.short_term.occupancy_pct = occupancy
        rows.append(_row(_signed(s, " pts"), occupancy, b, strategy, s == 0))
    tables.append(SensitivityTable(variable="occupancy", label="Occupancy", unit="percent", rows=rows))

    grid = None
    if not a.financing.is_cash:
        price_steps = (Decimal("-10"), Decimal("-5"), ZERO, Decimal("5"), Decimal("10"))
        rate_steps = (Decimal("-1"), Decimal("-0.5"), ZERO, Decimal("0.5"), Decimal("1"))
        values: list[list[Decimal | None]] = []
        for ps in price_steps:
            line: list[Decimal | None] = []
            for rs in rate_steps:
                variant = _vary_rate(_vary_price(a, ps), rs)
                line.append(analyze_strategy(variant, strategy).monthly_cash_flow)
            values.append(line)
        grid = SensitivityGrid(
            row_label="Purchase price",
            column_label="Interest rate",
            rows=[money(a.acquisition.purchase_price * (ONE + frac(s))) for s in price_steps],
            columns=[max(a.financing.interest_rate_pct + s, ZERO) for s in rate_steps],
            values=values,
        )

    return SensitivityResult(strategy=strategy, tables=tables, price_rate_grid=grid)


# ---------------------------------------------------------------------------
# Financing scenarios
# ---------------------------------------------------------------------------

PRESET_FINANCING: tuple[tuple[str, str, Decimal, int, Decimal], ...] = (
    # key, label, down %, term years, rate adjustment (pts) relative to the user's rate
    ("down20_30", "20% down · 30-year", Decimal("20"), 30, ZERO),
    ("down25_30", "25% down · 30-year", Decimal("25"), 30, ZERO),
    ("down30_15", "30% down · 15-year", Decimal("30"), 15, Decimal("-0.6")),
    ("cash", "All cash", Decimal("100"), 30, ZERO),
)


def financing_scenarios(
    a: Assumptions, custom: list[tuple[str, str, Financing]] | None = None
) -> list[FinancingScenarioResult]:
    """Compare loan structures. 15-year presets use a typical rate discount, shown to the user."""
    options: list[tuple[str, str, Financing]] = []
    for key, label, down, term, rate_adj in PRESET_FINANCING:
        fin = a.financing.model_copy(
            update={
                "down_payment_pct": down,
                "loan_term_years": term,
                "interest_rate_pct": max(a.financing.interest_rate_pct + rate_adj, ZERO),
            }
        )
        options.append((key, label, fin))
    options.append(("current", "Your assumptions", a.financing))
    options.extend(custom or [])

    out: list[FinancingScenarioResult] = []
    for key, label, fin in options:
        variant = a.model_copy(deep=True)
        variant.financing = fin
        variant.forecast.horizon_years = 30
        loan = build_loan_for(variant)
        ltr = analyze_strategy(variant, "ltr", loan)
        st = analyze_strategy(variant, "str", loan)
        ltr_fc = forecast(variant, "ltr", loan) if ltr.available else None
        str_fc = forecast(variant, "str", loan) if st.available else None
        upfront = ltr.total_cash_invested or st.total_cash_invested
        if upfront is None:
            upfront = total_cash_invested(cash_breakdown(variant, loan, "ltr"))
        out.append(
            FinancingScenarioResult(
                key=key,
                label=label,
                down_payment_pct=fin.down_payment_pct,
                interest_rate_pct=fin.interest_rate_pct,
                loan_term_years=fin.loan_term_years,
                is_cash=loan.is_cash,
                upfront_cash=money(upfront),
                monthly_payment=money(loan.monthly_principal_interest + loan.monthly_pmi),
                long_term=ltr,
                short_term=st,
                ltr_ten_year_profit=_h(ltr_fc, 10, "total_profit"),
                ltr_ten_year_irr_pct=_h(ltr_fc, 10, "irr_pct"),
                ltr_thirty_year_profit=_h(ltr_fc, 30, "total_profit"),
                str_ten_year_profit=_h(str_fc, 10, "total_profit"),
                str_ten_year_irr_pct=_h(str_fc, 10, "irr_pct"),
                str_thirty_year_profit=_h(str_fc, 30, "total_profit"),
            )
        )
    return out


def _h(fc: ForecastResult | None, years: int, attr: str) -> Decimal | None:
    if fc is None:
        return None
    horizon = _horizon(fc, years)
    return getattr(horizon, attr) if horizon else None
