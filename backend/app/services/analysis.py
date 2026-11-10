"""Builds assumptions for a property and runs the full analysis.

Value precedence (lowest → highest):

    1. documented model defaults               → provenance "default"
    2. listing / provider data for the property → "verified" (source facts) or
                                                  "estimated" (provider estimates, rate-based estimates)
    3. the user's standing defaults             → "user"
    4. property-specific overrides              → "user"

The engine itself (app.finance) is pure and deterministic; this module only
decides which numbers go into it and records where each one came from.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ValidationError

from app.core.config import get_settings
from app.core.errors import AppError
from app.finance.engine import analyze_both
from app.finance.inputs import Assumptions, Financing
from app.finance.projections import financing_scenarios, forecast, scenarios, sensitivity
from app.finance.quality import QualityInputs, assess_ltr, assess_str
from app.finance.scoring import ScoreWeights, recommend, score_strategy
from app.schemas.analysis import (
    AnalysisRequest,
    Badge,
    CustomFinancing,
    PropertyAnalysis,
    PropertyContext,
    Provenance,
)

# Fields that describe one specific property and therefore must never be taken
# from a user's standing defaults.
_PROPERTY_SPECIFIC = {
    ("acquisition", "purchase_price"),
    ("acquisition", "renovation_cost"),
    ("acquisition", "initial_repair_budget"),
    ("acquisition", "initial_reserves"),
    ("fixed", "property_tax_annual"),
    ("fixed", "insurance_annual"),
    ("fixed", "hoa_monthly"),
    ("long_term", "monthly_rent"),
    ("short_term", "adr"),
    ("short_term", "occupancy_pct"),
    ("short_term", "seasonality"),
    ("short_term", "max_rentable_nights"),
}

_SECTIONS = ("acquisition", "financing", "fixed", "long_term", "short_term", "forecast")


def default_furnishing_cost(bedrooms: Decimal | None) -> Decimal:
    """Typical turnkey STR furnishing budget: $6,000 base + $4,500 per bedroom."""
    beds = min(max(int(bedrooms or 2), 1), 8)
    return Decimal(6000 + 4500 * beds)


def default_cleaning_cost(bedrooms: Decimal | None) -> Decimal:
    beds = min(max(int(bedrooms or 2), 1), 8)
    return Decimal(60 + 25 * beds)


def _dump(model: BaseModel | None) -> dict[str, dict[str, Any]]:
    if model is None:
        return {}
    data = model.model_dump(exclude_unset=True)
    return {section: values for section, values in data.items() if isinstance(values, dict)}


def build_assumptions(
    ctx: PropertyContext | None,
    overrides: BaseModel | None = None,
    defaults: BaseModel | None = None,
) -> tuple[Assumptions, dict[str, Provenance]]:
    values: dict[str, dict[str, Any]] = {section: {} for section in _SECTIONS}
    provenance: dict[str, Provenance] = {}

    def put(section: str, name: str, value: Any, source: Provenance) -> None:
        values[section][name] = value
        provenance[f"{section}.{name}"] = source

    if ctx is not None:
        if ctx.price is not None:
            put("acquisition", "purchase_price", ctx.price, "verified")
        if ctx.property_tax_annual is not None:
            put("fixed", "property_tax_annual", ctx.property_tax_annual, "verified")
        else:
            provenance["fixed.property_tax_annual"] = "estimated"
        if ctx.hoa_fee_monthly is not None:
            put("fixed", "hoa_monthly", ctx.hoa_fee_monthly, "verified")
        else:
            provenance["fixed.hoa_monthly"] = "unavailable"
        provenance["fixed.insurance_annual"] = "estimated"

        if ctx.rent is not None:
            put("long_term", "monthly_rent", ctx.rent.rent, "estimated")
        else:
            provenance["long_term.monthly_rent"] = "unavailable"

        put("short_term", "furnishing_cost", default_furnishing_cost(ctx.bedrooms), "default")
        cleaning = default_cleaning_cost(ctx.bedrooms)
        put("short_term", "cleaning_cost_per_turnover", cleaning, "default")
        put("short_term", "cleaning_fee_per_stay", cleaning, "default")
        if ctx.short_term is not None:
            st = ctx.short_term
            put("short_term", "adr", st.adr, "estimated")
            put("short_term", "occupancy_pct", st.occupancy_pct, "estimated")
            put("short_term", "occupancy_basis", st.occupancy_basis, "estimated")
            put("short_term", "adr_includes_cleaning_fee", st.adr_includes_cleaning_fee, "estimated")
            if st.cleaning_fee is not None and not st.adr_includes_cleaning_fee:
                put("short_term", "cleaning_fee_per_stay", st.cleaning_fee, "estimated")
            if st.avg_stay_nights is not None:
                put("short_term", "avg_stay_nights", st.avg_stay_nights, "estimated")
            if st.seasonality:
                put("short_term", "seasonality", st.seasonality, "estimated")
        else:
            provenance["short_term.adr"] = "unavailable"
            provenance["short_term.occupancy_pct"] = "unavailable"
        if ctx.legality.max_nights_per_year is not None:
            put("short_term", "max_rentable_nights", ctx.legality.max_nights_per_year, "verified")

    for section, fields in _dump(defaults).items():
        for name, value in fields.items():
            if (section, name) not in _PROPERTY_SPECIFIC and value is not None:
                put(section, name, value, "user")
    for section, fields in _dump(overrides).items():
        for name, value in fields.items():
            put(section, name, value, "user")

    if "purchase_price" not in values["acquisition"] or values["acquisition"]["purchase_price"] is None:
        raise AppError(
            "A purchase price is required: this property has no list price, so provide acquisition.purchase_price.",
            code="missing_purchase_price",
            status_code=422,
        )
    try:
        assumptions = Assumptions.model_validate(values)
    except ValidationError as exc:
        fields = [{"field": ".".join(str(p) for p in err["loc"]), "message": err["msg"]} for err in exc.errors()]
        raise AppError("Invalid assumptions", code="validation_error", status_code=422, details={"fields": fields}) from exc

    # Anything not set above uses a documented model default.
    for section in _SECTIONS:
        for name in getattr(assumptions, section).__class__.model_fields:
            provenance.setdefault(f"{section}.{name}", "default")
    return assumptions, provenance


def _quality_inputs(ctx: PropertyContext | None, provenance: dict[str, Provenance], a: Assumptions) -> QualityInputs:
    rent_user = provenance.get("long_term.monthly_rent") == "user"
    str_user = "user" in (provenance.get("short_term.adr"), provenance.get("short_term.occupancy_pct"))
    tax_prov = provenance.get("fixed.property_tax_annual")

    rent_source = "none"
    if a.long_term.monthly_rent:
        rent_source = "user" if rent_user else (ctx.rent.source if ctx and ctx.rent else "none")
    str_source = "none"
    if a.short_term.adr and a.short_term.occupancy_pct:
        if str_user:
            str_source = "user"
        elif ctx and ctx.short_term:
            str_source = "provider_property" if ctx.short_term.level == "property" else "provider_market"

    return QualityInputs(
        listing_source=ctx.listing_source if ctx else None,
        listing_last_seen=ctx.last_seen_at if ctx else None,
        is_demo=bool(ctx and ctx.is_demo),
        rent_source=rent_source,  # type: ignore[arg-type]
        rent_provider=ctx.rent.provider if ctx and ctx.rent else None,
        rent_comp_count=ctx.rent.comp_count if ctx and ctx.rent else 0,
        rent_market_sample=ctx.rent.market_sample if ctx and ctx.rent else 0,
        rent_estimated_at=ctx.rent.fetched_at if ctx and ctx.rent else None,
        tax_source="source" if tax_prov == "verified" else "user" if tax_prov == "user" else "estimated",
        hoa_known=provenance.get("fixed.hoa_monthly") in ("verified", "user"),
        property_type=ctx.property_type if ctx else None,
        insurance_user_entered=provenance.get("fixed.insurance_annual") == "user",
        str_source=str_source,  # type: ignore[arg-type]
        str_provider=ctx.short_term.provider if ctx and ctx.short_term else None,
        str_estimated_at=ctx.short_term.fetched_at if ctx and ctx.short_term else None,
        str_legality=ctx.legality.status if ctx else "unknown",
        str_legality_verified=bool(ctx and ctx.legality.verified),
        has_beds=bool(ctx and ctx.bedrooms is not None),
        has_baths=bool(ctx and ctx.bathrooms is not None),
        has_sqft=bool(ctx and ctx.square_feet),
        has_year_built=bool(ctx and ctx.year_built),
        has_coordinates=bool(ctx and ctx.latitude is not None and ctx.longitude is not None),
    )


def build_badges(ctx: PropertyContext | None, analysis: PropertyAnalysis) -> list[Badge]:
    """Badges are rule-based and only shown when the underlying data exists.

    positive_cash_flow   primary strategy monthly cash flow > $0
    high_yield           long-term gross yield ≥ HIGH_YIELD_THRESHOLD_PCT (default 8%)
    price_reduced        listing history shows the current price below a previous asking price
    str_restrictions     STR legality recorded as restricted or prohibited
    below_market         list price ≥ BELOW_MARKET_THRESHOLD_PCT (default 5%) under the provider value estimate
    needs_verification   confidence Low / Insufficient, a conditional STR recommendation,
                         or both rent and property tax are non-property-specific estimates
    """
    settings = get_settings()
    badges: list[Badge] = []
    primary = analysis.long_term if analysis.primary_strategy != "str" else analysis.short_term

    if primary.available and primary.monthly_cash_flow is not None and primary.monthly_cash_flow > 0:
        badges.append(Badge(key="positive_cash_flow", label="Positive Cash Flow", tone="positive", detail=f"${primary.monthly_cash_flow:,.0f}/mo after debt service ({'short-term' if primary.strategy == 'str' else 'long-term'} rental)"))

    ltr = analysis.long_term
    if ltr.available and ltr.gross_yield_pct is not None and ltr.gross_yield_pct >= settings.high_yield_threshold_pct:
        badges.append(Badge(key="high_yield", label="High Rental Yield", tone="positive", detail=f"Long-term gross yield {ltr.gross_yield_pct}% (threshold {settings.high_yield_threshold_pct}%)"))

    if ctx and ctx.price_reduction:
        r = ctx.price_reduction
        badges.append(Badge(key="price_reduced", label="Price Reduced", tone="neutral", detail=f"Reduced {r.percent}% from ${r.previous_price:,.0f} on {r.changed_on.isoformat()}"))

    if ctx and ctx.value_estimate and ctx.price:
        discount = (ctx.value_estimate - ctx.price) / ctx.value_estimate * 100
        if discount >= settings.below_market_threshold_pct:
            badges.append(Badge(key="below_market", label="Below Estimated Market Value", tone="positive", detail=f"List price is {discount:.1f}% under the ${ctx.value_estimate:,.0f} value estimate"))

    legality = analysis.legality
    if legality.status in ("restricted", "prohibited"):
        badges.append(
            Badge(
                key="str_restrictions",
                label="STR Restrictions",
                tone="negative" if legality.status == "prohibited" else "warning",
                detail=legality.summary or f"Short-term rentals recorded as {legality.status}",
            )
        )

    reasons: list[str] = []
    if analysis.confidence in ("low", "insufficient"):
        reasons.append(f"data confidence is {analysis.confidence}")
    if analysis.recommendation.conditional:
        reasons.append("STR legality unverified")
    if analysis.provenance.get("fixed.property_tax_annual") == "estimated" and ctx and ctx.rent and ctx.rent.source == "market_zip":
        reasons.append("rent and property tax are area-level estimates")
    if reasons:
        badges.append(Badge(key="needs_verification", label="Needs Data Verification", tone="warning", detail="; ".join(reasons).capitalize()))
    return badges


def analyze(
    ctx: PropertyContext | None,
    *,
    overrides: BaseModel | None = None,
    defaults: BaseModel | None = None,
    weights: ScoreWeights | None = None,
    include: list[str] | None = None,
    custom_financing: list[CustomFinancing] | None = None,
) -> PropertyAnalysis:
    weights = weights or ScoreWeights()
    include = include or []
    assumptions, provenance = build_assumptions(ctx, overrides, defaults)
    ltr, st, loan = analyze_both(assumptions)

    quality = _quality_inputs(ctx, provenance, assumptions)
    quality_ltr, quality_str = assess_ltr(quality), assess_str(quality)
    legality = ctx.legality if ctx else PropertyContext.model_fields["legality"].default_factory()  # type: ignore[misc]
    dom = ctx.days_on_market if ctx else None
    score_ltr = score_strategy(ltr, quality_ltr, weights, days_on_market=dom, legality=legality.status)
    score_str = score_strategy(st, quality_str, weights, days_on_market=dom, legality=legality.status)
    recommendation = recommend(ltr, st, legality.status)

    primary = recommendation.strategy
    overall = (score_str if primary == "str" else score_ltr).score if primary else None
    confidence = (quality_str if primary == "str" else quality_ltr).label

    analysis = PropertyAnalysis(
        property_id=ctx.id if ctx else None,
        assumptions=assumptions,
        provenance=provenance,
        loan=loan,
        long_term=ltr,
        short_term=st,
        quality_ltr=quality_ltr,
        quality_str=quality_str,
        score_ltr=score_ltr,
        score_str=score_str,
        recommendation=recommendation,
        primary_strategy=primary,
        overall_score=overall,
        confidence=confidence,
        legality=legality,
        badges=[],
        is_demo=bool(ctx and ctx.is_demo),
    )
    analysis.badges = build_badges(ctx, analysis)

    if "forecast" in include:
        analysis.forecast_ltr = forecast(assumptions, "ltr")
        analysis.forecast_str = forecast(assumptions, "str")
    if "scenarios" in include:
        analysis.scenarios_ltr = scenarios(assumptions, "ltr")
        analysis.scenarios_str = scenarios(assumptions, "str")
    if "sensitivity" in include:
        analysis.sensitivity_ltr = sensitivity(assumptions, "ltr")
        analysis.sensitivity_str = sensitivity(assumptions, "str")
    if "financing" in include:
        custom = [
            (
                f"custom_{index}",
                item.name,
                assumptions.financing.model_copy(
                    update={"down_payment_pct": item.down_payment_pct, "interest_rate_pct": item.interest_rate_pct, "loan_term_years": item.loan_term_years}
                ),
            )
            for index, item in enumerate(custom_financing or [])
        ]
        analysis.financing = financing_scenarios(assumptions, _validated(custom))
    return analysis


def _validated(custom: list[tuple[str, str, Financing]]) -> list[tuple[str, str, Financing]]:
    return [(key, label, Financing.model_validate(fin.model_dump())) for key, label, fin in custom]


def analyze_request(ctx: PropertyContext | None, request: AnalysisRequest) -> PropertyAnalysis:
    return analyze(
        ctx,
        overrides=request.overrides,
        defaults=request.defaults,
        weights=request.weights,
        include=list(request.include),
        custom_financing=request.custom_financing,
    )
