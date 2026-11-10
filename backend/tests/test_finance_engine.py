"""Financial engine tests. Expected values are computed by hand in the comments."""

from decimal import Decimal as D

import pytest

from app.finance.engine import analyze_both, analyze_strategy, build_loan_for
from app.finance.inputs import (
    Acquisition,
    Assumptions,
    CapitalImprovement,
    Financing,
    FixedExpenses,
    Forecast,
    LongTermRental,
    ShortTermRental,
)
from app.finance.mortgage import build_loan, monthly_payment
from app.finance.projections import financing_scenarios, forecast, irr, scenarios, sensitivity


def base(**overrides) -> Assumptions:
    data = dict(
        acquisition=Acquisition(purchase_price=D("300000")),
        financing=Financing(down_payment_pct=D("25"), interest_rate_pct=D("7"), loan_term_years=30),
        fixed=FixedExpenses(),
        long_term=LongTermRental(monthly_rent=D("2500")),
        short_term=ShortTermRental(adr=D("200"), occupancy_pct=D("60"), unavailable_nights=0, furnishing_cost=D("20000")),
    )
    data.update(overrides)
    return Assumptions(**data)


# --- Mortgage ---------------------------------------------------------------


@pytest.mark.parametrize(
    "principal,rate,months,expected",
    [
        ("100000", "7", 360, "665.30"),
        ("200000", "6", 360, "1199.10"),
        ("225000", "7", 360, "1496.93"),
        ("150000", "5.5", 180, "1225.63"),
        ("120000", "0", 120, "1000.00"),
    ],
)
def test_monthly_payment(principal, rate, months, expected):
    assert monthly_payment(D(principal), D(rate), months) == D(expected)


def test_amortization_reconciles_to_zero():
    loan = build_loan(D("300000"), Financing(down_payment_pct=D("25"), interest_rate_pct=D("7")))
    assert loan.loan_amount == D("225000.00")
    assert len(loan.years) == 30
    assert loan.years[-1].ending_balance == 0
    assert sum(y.principal_paid for y in loan.years) == D("225000.00")
    # Year 1: 12 level payments
    assert loan.years[0].debt_service == D("1496.93") * 12
    # Balance after year 1 of a 7% / 30y loan is 98.984% of principal
    assert abs(loan.years[0].ending_balance - D("222714.41")) < D("1.00")


def test_cash_purchase_has_no_loan():
    loan = build_loan(D("300000"), Financing(down_payment_pct=D("100")))
    assert loan.is_cash and loan.loan_amount == 0 and loan.first_year_debt_service == 0


def test_pmi_charged_below_20_down_and_removed_at_78_ltv():
    fin = Financing(down_payment_pct=D("10"), interest_rate_pct=D("7"), pmi_annual_rate_pct=D("0.75"))
    loan = build_loan(D("300000"), fin)
    assert loan.monthly_pmi == D("168.75")  # 270,000 × 0.75% / 12
    assert 0 < loan.pmi_months < 360
    # PMI stops once balance ≤ 78% × 300,000 = 234,000
    months = 0
    balance = loan.loan_amount
    r = D("0.07") / 12
    while balance > D("234000"):
        interest = (balance * r).quantize(D("0.01"))
        balance -= loan.monthly_principal_interest - interest
        months += 1
    assert loan.pmi_months == months
    assert sum(y.pmi_paid for y in loan.years) == loan.monthly_pmi * loan.pmi_months


def test_no_pmi_at_20_down():
    assert build_loan(D("300000"), Financing(down_payment_pct=D("20"))).monthly_pmi == 0


# --- Long-term rental ---------------------------------------------------------


def test_ltr_metrics_match_hand_calculation():
    r = analyze_strategy(base(), "ltr")
    assert r.available
    assert r.gross_annual_income == D("30000.00")
    assert r.gross_yield_pct == D("10.00")  # 30,000 / 300,000
    assert r.vacancy_loss == D("1800.00")  # 6%
    assert r.effective_gross_income == D("28200.00")
    lines = {e.key: e.annual for e in r.expenses}
    assert lines["property_tax"] == D("3300.00")  # 1.1%
    assert lines["insurance"] == D("1500.00")  # 0.5%
    assert lines["management"] == D("2256.00")  # 8% of collected 28,200
    assert lines["maintenance"] == D("2400.00")
    assert lines["capex"] == D("1500.00")
    assert lines["leasing"] == D("437.50")  # 2,500 × 50% × 35%
    assert r.operating_expenses_annual == D("11393.50")
    assert r.noi_annual == D("16806.50")
    assert r.cap_rate_pct == D("5.60")
    assert r.annual_debt_service == D("17963.16")  # 1,496.93 × 12
    assert r.annual_cash_flow == D("-1156.66")
    assert r.monthly_cash_flow == D("-96.39")
    assert r.dscr == D("0.936")
    # Cash: 75,000 down + 9,000 closing + 500 inspection + 3 × (1,496.93 + 275 + 125) reserves
    assert r.total_cash_invested == D("90190.79")
    assert r.cash_on_cash_pct == D("-1.28")
    assert r.acquisition_basis == D("309500.00")
    assert r.net_yield_pct == D("5.43")
    # (9,137.50 fixed + 17,963.16 debt) / (30,000 × 0.92)
    assert r.break_even_occupancy_pct == D("98.19")


def test_noi_excludes_financing():
    financed = analyze_strategy(base(), "ltr")
    cash = analyze_strategy(base(financing=Financing(down_payment_pct=D("100"))), "ltr")
    assert financed.noi_annual == cash.noi_annual
    assert financed.cap_rate_pct == cash.cap_rate_pct
    assert cash.dscr is None  # not applicable
    assert cash.annual_debt_service == 0
    assert cash.annual_cash_flow == cash.noi_annual


def test_ltr_unavailable_without_rent():
    r = analyze_strategy(base(long_term=LongTermRental(monthly_rent=None)), "ltr")
    assert not r.available and r.noi_annual is None and r.unavailable_reason


def test_explicit_tax_overrides_rate():
    r = analyze_strategy(base(fixed=FixedExpenses(property_tax_annual=D("4200"), hoa_monthly=D("150"))), "ltr")
    lines = {e.key: e.annual for e in r.expenses}
    assert lines["property_tax"] == D("4200.00") and lines["hoa"] == D("1800.00")


def test_break_even_flags_impossible():
    r = analyze_strategy(base(long_term=LongTermRental(monthly_rent=D("1200"))), "ltr")
    assert r.break_even_occupancy_pct > 100 and "100%" in r.break_even_note


# --- Short-term rental --------------------------------------------------------


def test_str_revenue_formula_adr_x_365_x_occupancy():
    r = analyze_strategy(base(), "str")
    d = r.str_detail
    assert d.booked_nights == D("219.0")  # 365 × 60%
    assert d.accommodation_revenue == D("43800.00")  # 200 × 365 × 0.60
    # 219 / 3.5 = 62.571 stays × $110
    assert d.cleaning_fee_revenue == D("6882.86")
    assert r.gross_annual_income == D("50682.86")
    lines = {e.key: e.annual for e in r.expenses}
    assert lines["platform_fees"] == D("1520.49")  # 3% of all booking revenue
    assert lines["management"] == D("8760.00")  # 20% of accommodation
    assert lines["cleaning"] == D("6882.86")  # equals the fee collected: pass-through
    assert lines["consumables"] == D("1126.29")
    assert lines["utilities"] == D("3120.00") and lines["internet"] == D("840.00")
    assert sum(d.monthly_revenue) == pytest.approx(r.gross_annual_income, abs=D("0.10"))
    # Furnishing is STR-only capital
    assert r.total_cash_invested == D("90190.79") + D("20000")


def test_cleaning_fee_not_double_counted_when_adr_includes_it():
    included = analyze_strategy(
        base(short_term=ShortTermRental(adr=D("200"), occupancy_pct=D("60"), unavailable_nights=0, adr_includes_cleaning_fee=True)),
        "str",
    )
    assert included.str_detail.cleaning_fee_revenue == 0
    assert included.gross_annual_income == D("43800.00")
    assert {e.key: e.annual for e in included.expenses}["cleaning"] == D("6882.86")  # cost still incurred


def test_unavailable_nights_and_occupancy_basis():
    available = analyze_strategy(
        base(short_term=ShortTermRental(adr=D("200"), occupancy_pct=D("60"), unavailable_nights=65)), "str"
    ).str_detail
    assert available.available_nights == 300 and available.booked_nights == D("180.0")
    assert available.calendar_occupancy_pct == D("49.32")  # 180 / 365
    calendar = analyze_strategy(
        base(short_term=ShortTermRental(adr=D("200"), occupancy_pct=D("60"), unavailable_nights=65, occupancy_basis="calendar")),
        "str",
    ).str_detail
    assert calendar.booked_nights == D("219.0") and calendar.available_occupancy_pct == D("73.00")


def test_regulatory_night_cap_limits_revenue():
    r = analyze_strategy(
        base(short_term=ShortTermRental(adr=D("200"), occupancy_pct=D("60"), unavailable_nights=0, max_rentable_nights=90)),
        "str",
    )
    assert r.str_detail.nights_capped_by_regulation
    assert r.str_detail.accommodation_revenue == D("18000.00")


def test_str_break_even_is_consistent():
    """At the reported break-even occupancy, cash flow is ~zero."""
    a = base()
    be = analyze_strategy(a, "str").break_even_occupancy_pct
    probe = a.model_copy(deep=True)
    probe.short_term.occupancy_pct = be
    assert abs(analyze_strategy(probe, "str").annual_cash_flow) < D("60")


def test_ltr_break_even_is_consistent():
    a = base(long_term=LongTermRental(monthly_rent=D("3200")))
    be = analyze_strategy(a, "ltr").break_even_occupancy_pct
    probe = a.model_copy(deep=True)
    probe.long_term.vacancy_pct = 100 - be
    assert abs(analyze_strategy(probe, "ltr").annual_cash_flow) < D("5")


def test_seasonality_shifts_months_not_annual_total():
    weights = [D(x) for x in ("0.6", "0.7", "1.0", "1.1", "1.2", "1.5", "1.6", "1.5", "1.0", "0.9", "0.6", "0.7")]
    flat = analyze_strategy(base(), "str")
    seasonal = analyze_strategy(
        base(short_term=ShortTermRental(adr=D("200"), occupancy_pct=D("60"), unavailable_nights=0, seasonality=weights)), "str"
    )
    assert seasonal.gross_annual_income == flat.gross_annual_income
    assert seasonal.str_detail.monthly_revenue[6] > seasonal.str_detail.monthly_revenue[0] * 2


def test_seasonality_validation():
    with pytest.raises(ValueError):
        ShortTermRental(seasonality=[D("1")] * 11)


# --- Forecast ---------------------------------------------------------------


def test_forecast_year_one_matches_point_in_time_and_identities_hold():
    a = base()
    loan = build_loan_for(a)
    point = analyze_strategy(a, "ltr", loan)
    fc = forecast(a, "ltr", loan)
    y1 = fc.years[0]
    assert y1.noi == point.noi_annual and y1.cash_flow == point.annual_cash_flow
    assert len(fc.years) == 30 and [h.years for h in fc.horizons] == [1, 5, 10, 15, 30]
    assert fc.years[-1].loan_balance == 0
    for y in fc.years:
        assert y.equity == y.property_value - y.loan_balance
    # Profit decomposition: cash flow + principal + appreciation − selling costs − non-recoverable costs
    h = fc.horizons[2]
    unrecovered = D("9000") + D("500")  # closing + inspection
    assert h.total_profit == h.cumulative_cash_flow + h.principal_reduction + h.appreciation - h.selling_costs - unrecovered
    assert h.property_value == (D("300000") * D("1.03") ** 10).quantize(D("0.01"))


def test_forecast_growth_and_capital_improvements():
    a = base(forecast=Forecast(rent_growth_pct=D("3"), capital_improvements=[CapitalImprovement(year=3, amount=D("8000"))]))
    fc = forecast(a, "ltr")
    assert fc.years[1].gross_income == D("30900.00")  # +3%
    assert fc.years[2].capital_improvements == D("8000.00")
    assert fc.years[2].cash_flow < fc.years[1].cash_flow


def test_irr_known_values():
    assert irr([D("-1000"), D("1100")]) == D("10.00")
    assert irr([D("-1000"), D("0"), D("1210")]) == D("10.00")
    assert irr([D("100"), D("100")]) is None


# --- Scenarios / sensitivity / financing ---------------------------------------


@pytest.mark.parametrize("strategy", ["ltr", "str"])
def test_scenarios_are_ordered(strategy):
    out = {s.name: s for s in scenarios(base(), strategy)}
    assert out["conservative"].result.noi_annual < out["base"].result.noi_annual < out["optimistic"].result.noi_annual
    assert out["base"].result.noi_annual == analyze_strategy(base(), strategy).noi_annual
    assert out["conservative"].changes and out["conservative"].ten_year_total_profit is not None


def test_sensitivity_tables_are_monotonic():
    s = sensitivity(base(), "ltr")
    tables = {t.variable: t for t in s.tables}
    assert set(tables) == {"purchase_price", "interest_rate", "rent", "occupancy"}
    price = [r.monthly_cash_flow for r in tables["purchase_price"].rows]
    rate = [r.monthly_cash_flow for r in tables["interest_rate"].rows]
    rent = [r.monthly_cash_flow for r in tables["rent"].rows]
    occ = [r.monthly_cash_flow for r in tables["occupancy"].rows]
    assert price == sorted(price, reverse=True) and rate == sorted(rate, reverse=True)
    assert rent == sorted(rent) and occ == sorted(occ)
    assert sum(r.is_base for r in tables["rent"].rows) == 1
    assert len(s.price_rate_grid.values) == 5 and len(s.price_rate_grid.values[0]) == 5


def test_financing_scenarios():
    out = {f.key: f for f in financing_scenarios(base())}
    assert {"down20_30", "down25_30", "down30_15", "cash", "current"} <= set(out)
    assert out["cash"].is_cash and out["cash"].long_term.dscr is None and out["cash"].monthly_payment == 0
    assert out["down20_30"].upfront_cash < out["down25_30"].upfront_cash < out["cash"].upfront_cash
    assert out["down20_30"].long_term.monthly_cash_flow < out["down25_30"].long_term.monthly_cash_flow
    assert out["down30_15"].monthly_payment > out["down25_30"].monthly_payment
    assert out["cash"].ltr_thirty_year_profit is not None


def test_engine_is_deterministic():
    assert analyze_both(base()) == analyze_both(base())
