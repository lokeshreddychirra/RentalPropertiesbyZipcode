"""Risk-adjusted investment score (0–100) and strategy recommendation.

Score = Σ weightᵢ × componentᵢ / Σ weightᵢ, where every component is first
normalised to 0–100 on a fixed scale (so scores are comparable across searches,
not relative to whatever else happens to be in the result set):

    component          0 points at     100 points at   notes
    cash_on_cash       0 %             12 %            leveraged return
    cap_rate           3 %             10 %            unleveraged operating return
    cash_flow          −$200 / month   +$800 / month
    dscr               1.00            1.75            cash purchases score 100 (no debt risk)
    rent_confidence    Insufficient 0 · Low 30 · Medium 65 · High 100
    market_risk        60% break-even headroom + 20% liquidity + 20% regulatory (see below)
    data_quality       the 0–100 data-quality score

    break-even headroom: break-even occupancy ≤ 60% → 100, ≥ 100% → 0
    liquidity:           days on market ≤ 30 → 100, ≥ 180 → 0 (unknown → 50)
    regulatory:          LTR 100; STR permitted 100, unknown 40, restricted 30, prohibited 0

Guard rails so weak data can never produce a strong ranking:
    confidence Insufficient → score capped at 40
    confidence Low          → score capped at 70
    STR prohibited          → STR score is 0 and STR is never recommended
    strategy unavailable    → no score (unranked)
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .money import HUNDRED, ZERO, clamp
from .quality import ConfidenceLabel, Legality, QualityAssessment
from .results import Num, StrategyResult

COMPONENTS = ("cash_on_cash", "cap_rate", "cash_flow", "dscr", "rent_confidence", "market_risk", "data_quality")

COMPONENT_LABELS = {
    "cash_on_cash": "Cash-on-cash return",
    "cap_rate": "Cap rate",
    "cash_flow": "Monthly cash flow",
    "dscr": "Debt service coverage",
    "rent_confidence": "Rental estimate confidence",
    "market_risk": "Vacancy & market risk",
    "data_quality": "Data freshness & completeness",
}

CONFIDENCE_POINTS: dict[str, Decimal] = {
    "insufficient": Decimal("0"),
    "low": Decimal("30"),
    "medium": Decimal("65"),
    "high": Decimal("100"),
}
SCORE_CAPS: dict[str, Decimal] = {"insufficient": Decimal("40"), "low": Decimal("70")}
REGULATORY_POINTS: dict[str, Decimal] = {
    "permitted": Decimal("100"),
    "unknown": Decimal("40"),
    "restricted": Decimal("30"),
    "prohibited": Decimal("0"),
}


class ScoreWeights(BaseModel):
    cash_on_cash: Decimal = Field(default=Decimal("25"), ge=0, le=100)
    cap_rate: Decimal = Field(default=Decimal("20"), ge=0, le=100)
    cash_flow: Decimal = Field(default=Decimal("20"), ge=0, le=100)
    dscr: Decimal = Field(default=Decimal("10"), ge=0, le=100)
    rent_confidence: Decimal = Field(default=Decimal("10"), ge=0, le=100)
    market_risk: Decimal = Field(default=Decimal("10"), ge=0, le=100)
    data_quality: Decimal = Field(default=Decimal("5"), ge=0, le=100)

    @model_validator(mode="after")
    def _non_zero(self) -> ScoreWeights:
        if sum(getattr(self, name) for name in COMPONENTS) <= 0:
            raise ValueError("at least one score weight must be greater than zero")
        return self


class ScoreComponent(BaseModel):
    key: str
    label: str
    weight_pct: Num  # normalised weight, percent of total
    normalized: Num  # 0–100
    contribution: Num  # points contributed to the final score
    detail: str


class InvestmentScore(BaseModel):
    strategy: Literal["ltr", "str"]
    score: Num | None
    uncapped_score: Num | None = None
    cap_applied: str | None = None
    components: list[ScoreComponent] = []


def linear(value: Decimal | None, zero_at: Decimal, full_at: Decimal) -> Decimal:
    """Map ``value`` linearly so zero_at → 0 and full_at → 100, clamped."""
    if value is None:
        return ZERO
    return clamp((value - zero_at) / (full_at - zero_at) * HUNDRED, ZERO, HUNDRED)


def market_risk_component(
    result: StrategyResult, days_on_market: int | None, legality: Legality
) -> tuple[Decimal, str]:
    be = result.break_even_occupancy_pct
    headroom = ZERO if be is None else linear(be, Decimal("100"), Decimal("60"))
    liquidity = Decimal("50") if days_on_market is None else linear(Decimal(days_on_market), Decimal("180"), Decimal("30"))
    regulatory = HUNDRED if result.strategy == "ltr" else REGULATORY_POINTS[legality]
    value = headroom * Decimal("0.6") + liquidity * Decimal("0.2") + regulatory * Decimal("0.2")
    be_text = "n/a" if be is None else f"{be}%"
    dom_text = "unknown" if days_on_market is None else str(days_on_market)
    return value, f"Break-even occupancy {be_text}; {dom_text} days on market; regulatory {int(regulatory)}/100"


def score_strategy(
    result: StrategyResult,
    quality: QualityAssessment,
    weights: ScoreWeights,
    *,
    days_on_market: int | None = None,
    legality: Legality = "unknown",
) -> InvestmentScore:
    strategy = result.strategy
    if not result.available:
        return InvestmentScore(strategy=strategy, score=None)

    dscr_value = HUNDRED if result.dscr is None else linear(result.dscr, Decimal("1.0"), Decimal("1.75"))
    risk_value, risk_detail = market_risk_component(result, days_on_market, legality)
    confidence: ConfidenceLabel = quality.label

    normalized: dict[str, tuple[Decimal, str]] = {
        "cash_on_cash": (linear(result.cash_on_cash_pct, ZERO, Decimal("12")), f"{result.cash_on_cash_pct}%"),
        "cap_rate": (linear(result.cap_rate_pct, Decimal("3"), Decimal("10")), f"{result.cap_rate_pct}%"),
        "cash_flow": (linear(result.monthly_cash_flow, Decimal("-200"), Decimal("800")), f"${result.monthly_cash_flow}/mo"),
        "dscr": (dscr_value, "No debt (cash purchase)" if result.dscr is None else f"{result.dscr}×"),
        "rent_confidence": (CONFIDENCE_POINTS[confidence], confidence.capitalize()),
        "market_risk": (risk_value, risk_detail),
        "data_quality": (Decimal(quality.score), f"{quality.score}/100"),
    }

    total_weight = sum((getattr(weights, name) for name in COMPONENTS), ZERO)
    components: list[ScoreComponent] = []
    score = ZERO
    for name in COMPONENTS:
        weight = getattr(weights, name) / total_weight
        value, detail = normalized[name]
        contribution = weight * value
        score += contribution
        components.append(
            ScoreComponent(
                key=name,
                label=COMPONENT_LABELS[name],
                weight_pct=(weight * HUNDRED).quantize(Decimal("0.1")),
                normalized=value.quantize(Decimal("0.1")),
                contribution=contribution.quantize(Decimal("0.1")),
                detail=detail,
            )
        )

    uncapped = score.quantize(Decimal("0.1"))
    cap_note = None
    if strategy == "str" and legality == "prohibited":
        score, cap_note = ZERO, "Short-term rentals are recorded as prohibited here"
    elif confidence in SCORE_CAPS and score > SCORE_CAPS[confidence]:
        score = SCORE_CAPS[confidence]
        cap_note = f"Capped at {SCORE_CAPS[confidence]} because data confidence is {confidence}"
    return InvestmentScore(
        strategy=strategy,
        score=score.quantize(Decimal("0.1")),
        uncapped_score=uncapped,
        cap_applied=cap_note,
        components=components,
    )


class Recommendation(BaseModel):
    strategy: Literal["ltr", "str"] | None
    conditional: bool = False
    headline: str
    reasons: list[str]
    regulatory_risk_ltr: str = "Low — standard residential leasing; confirm local landlord-tenant and licensing rules."
    regulatory_risk_str: str = ""


_LEGALITY_RISK = {
    "permitted": "Lower — recorded as permitted; permits, taxes and HOA rules still apply.",
    "restricted": "Elevated — recorded as restricted (permit, zoning or night caps may apply).",
    "prohibited": "Blocking — recorded as prohibited at this location.",
    "unknown": "Unknown — local short-term rental rules have not been verified.",
}

# Cash-on-cash gap (percentage points) below which the strategies are treated as equivalent.
MATERIALITY_PTS = Decimal("0.5")


def recommend(ltr: StrategyResult, st: StrategyResult, legality: Legality) -> Recommendation:
    """Pick the financially stronger *feasible* strategy.

    Comparison uses cash-on-cash return (it accounts for the extra furnishing
    capital STR requires), falling back to annual cash flow when either is
    undefined. STR is never recommended when recorded as prohibited, and is
    recommended only conditionally when legality is unknown or restricted.
    """
    risk_str = _LEGALITY_RISK[legality]
    str_feasible = st.available and legality != "prohibited"

    if not ltr.available and not st.available:
        return Recommendation(
            strategy=None,
            headline="Not enough data to compare strategies",
            reasons=["Neither a long-term rent estimate nor short-term rental revenue is available."],
            regulatory_risk_str=risk_str,
        )
    if not str_feasible:
        reasons = (
            ["Short-term rentals are recorded as prohibited at this location, so only long-term rental is considered."]
            if st.available
            else ["No short-term rental revenue estimate is available."]
        )
        if not ltr.available:
            return Recommendation(strategy=None, headline="No feasible strategy can be evaluated", reasons=reasons, regulatory_risk_str=risk_str)
        return Recommendation(strategy="ltr", headline="Long-term rental", reasons=reasons, regulatory_risk_str=risk_str)
    if not ltr.available:
        conditional = legality in ("unknown", "restricted")
        return Recommendation(
            strategy="str",
            conditional=conditional,
            headline="Short-term rental" + (" — subject to legal verification" if conditional else ""),
            reasons=["No long-term rent estimate is available for comparison."],
            regulatory_risk_str=risk_str,
        )

    use_coc = ltr.cash_on_cash_pct is not None and st.cash_on_cash_pct is not None
    ltr_metric = ltr.cash_on_cash_pct if use_coc else ltr.annual_cash_flow
    str_metric = st.cash_on_cash_pct if use_coc else st.annual_cash_flow
    assert ltr_metric is not None and str_metric is not None
    gap = str_metric - ltr_metric
    cash_gap = (st.monthly_cash_flow or ZERO) - (ltr.monthly_cash_flow or ZERO)
    material = abs(gap) >= MATERIALITY_PTS if use_coc else abs(gap) >= Decimal("600")

    comparison = (
        f"Cash-on-cash: long-term {ltr.cash_on_cash_pct}% vs short-term {st.cash_on_cash_pct}%."
        if use_coc
        else f"Annual cash flow: long-term ${ltr.annual_cash_flow} vs short-term ${st.annual_cash_flow}."
    )
    cash_text = f"Monthly cash flow differs by ${abs(cash_gap)} in favour of {'short-term' if cash_gap > 0 else 'long-term'} rental."

    if not material:
        return Recommendation(
            strategy="ltr",
            headline="Long-term rental (returns are comparable)",
            reasons=[comparison, "The difference is not material, so the operationally simpler, lower-risk strategy is preferred."],
            regulatory_risk_str=risk_str,
        )
    if gap < 0:
        return Recommendation(strategy="ltr", headline="Long-term rental", reasons=[comparison, cash_text], regulatory_risk_str=risk_str)

    reasons = [comparison, cash_text, f"Short-term rental needs ${st.total_cash_invested} upfront vs ${ltr.total_cash_invested} for long-term."]
    if legality == "permitted":
        return Recommendation(strategy="str", headline="Short-term rental", reasons=reasons, regulatory_risk_str=risk_str)
    condition = (
        "Local short-term rental rules have not been verified — this recommendation only holds if STR operation is legal here."
        if legality == "unknown"
        else "Short-term rentals are restricted here — this recommendation only holds if you can meet the permit, zoning or night-cap rules."
    )
    return Recommendation(
        strategy="str",
        conditional=True,
        headline="Short-term rental — subject to legal verification",
        reasons=[*reasons, condition],
        regulatory_risk_str=risk_str,
    )
