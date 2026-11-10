"""Fixed-rate mortgage amortization with PMI.

The schedule is built month by month with each payment rounded to cents, the way
a servicer does it, so yearly totals reconcile exactly with the final balance.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .inputs import Financing
from .money import HUNDRED, ONE, TWELVE, ZERO, frac, money


@dataclass(frozen=True)
class YearOfLoan:
    year: int
    principal_paid: Decimal
    interest_paid: Decimal
    pmi_paid: Decimal
    ending_balance: Decimal

    @property
    def debt_service(self) -> Decimal:
        """Total financing payments in the year (principal + interest + PMI)."""
        return self.principal_paid + self.interest_paid + self.pmi_paid


@dataclass(frozen=True)
class Loan:
    purchase_price: Decimal
    down_payment: Decimal
    loan_amount: Decimal
    monthly_principal_interest: Decimal
    monthly_pmi: Decimal  # initial monthly PMI (0 when not required)
    pmi_months: int  # number of months PMI is charged
    term_months: int
    years: tuple[YearOfLoan, ...]

    @property
    def is_cash(self) -> bool:
        return self.loan_amount == 0

    @property
    def first_year_debt_service(self) -> Decimal:
        return self.years[0].debt_service if self.years else ZERO

    def year(self, n: int) -> YearOfLoan:
        """Year ``n`` (1-based). After payoff returns a zero year."""
        if 1 <= n <= len(self.years):
            return self.years[n - 1]
        return YearOfLoan(n, ZERO, ZERO, ZERO, ZERO)

    def balance_after_year(self, n: int) -> Decimal:
        if n <= 0:
            return self.loan_amount
        return self.year(n).ending_balance


def monthly_payment(principal: Decimal, annual_rate_pct: Decimal, term_months: int) -> Decimal:
    """Standard annuity payment: P·r / (1 − (1+r)^−n). Zero-rate loans amortize linearly."""
    if principal <= 0:
        return ZERO
    if term_months <= 0:
        raise ValueError("term_months must be positive")
    r = frac(annual_rate_pct) / TWELVE
    if r == 0:
        return money(principal / term_months)
    growth = (ONE + r) ** term_months
    return money(principal * r * growth / (growth - ONE))


def build_loan(purchase_price: Decimal, financing: Financing) -> Loan:
    down_payment = money(purchase_price * frac(financing.down_payment_pct))
    loan_amount = money(purchase_price - down_payment)
    term_months = financing.loan_term_years * 12

    if loan_amount <= 0:
        return Loan(purchase_price, money(purchase_price), ZERO, ZERO, ZERO, 0, term_months, ())

    payment = monthly_payment(loan_amount, financing.interest_rate_pct, term_months)
    monthly_rate = frac(financing.interest_rate_pct) / TWELVE

    pmi_applies = (
        financing.down_payment_pct < financing.pmi_required_below_down_pct and financing.pmi_annual_rate_pct > 0
    )
    monthly_pmi = money(loan_amount * frac(financing.pmi_annual_rate_pct) / TWELVE) if pmi_applies else ZERO
    # PMI terminates once the scheduled balance reaches the removal LTV, measured
    # against the original purchase price (no credit taken for appreciation).
    pmi_floor = purchase_price * financing.pmi_removal_ltv_pct / HUNDRED

    balance = loan_amount
    years: list[YearOfLoan] = []
    pmi_months = 0
    y_principal = y_interest = y_pmi = ZERO

    for month in range(1, term_months + 1):
        pmi_due = ZERO
        if pmi_applies and balance > pmi_floor:
            pmi_due = monthly_pmi
            pmi_months += 1
        interest = money(balance * monthly_rate)
        principal = payment - interest
        if month == term_months or principal >= balance:
            principal = balance  # final payment clears any rounding residue
        balance = balance - principal
        y_principal += principal
        y_interest += interest
        y_pmi += pmi_due
        if month % 12 == 0 or balance == 0:
            years.append(YearOfLoan(len(years) + 1, y_principal, y_interest, y_pmi, balance))
            y_principal = y_interest = y_pmi = ZERO
            if balance == 0:
                break

    return Loan(
        purchase_price=purchase_price,
        down_payment=down_payment,
        loan_amount=loan_amount,
        monthly_principal_interest=payment,
        monthly_pmi=monthly_pmi,
        pmi_months=pmi_months,
        term_months=term_months,
        years=tuple(years),
    )
