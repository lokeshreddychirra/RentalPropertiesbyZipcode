"""Decimal helpers. All money maths in the engine uses ``Decimal`` — never floats."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, getcontext

getcontext().prec = 34

ZERO = Decimal("0")
ONE = Decimal("1")
HUNDRED = Decimal("100")
TWELVE = Decimal("12")
CENT = Decimal("0.01")
BP = Decimal("0.01")  # percent values are reported to 2 decimal places


def D(value: object) -> Decimal:
    """Convert to Decimal without going through binary floating point."""
    if isinstance(value, Decimal):
        return value
    if value is None:
        return ZERO
    return Decimal(str(value))


def money(value: Decimal) -> Decimal:
    """Round to cents (half-up, the convention used on loan statements)."""
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def pct(value: Decimal) -> Decimal:
    """Round a percentage to two decimal places."""
    return value.quantize(BP, rounding=ROUND_HALF_UP)


def ratio(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


def frac(percent: Decimal) -> Decimal:
    """Percent (e.g. 7.5) -> fraction (0.075)."""
    return percent / HUNDRED


def safe_div(numerator: Decimal, denominator: Decimal) -> Decimal | None:
    if denominator == 0:
        return None
    return numerator / denominator


def clamp(value: Decimal, low: Decimal, high: Decimal) -> Decimal:
    return max(low, min(high, value))
