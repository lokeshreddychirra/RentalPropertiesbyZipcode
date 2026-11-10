"""Data-quality assessment and confidence labels.

Every analysis carries a 0–100 data-quality score and a label. The rules are
intentionally simple, additive and documented (docs/FINANCIAL_MODEL.md §7):

Long-term rental (max 100)
    Listing freshness      20  (seen ≤2 days: 20, ≤7: 15, ≤30: 8, older/unknown: 0)
    Rent estimate          40  (property-level AVM ≥5 comps: 40, 3–4 comps: 30, <3 comps: 20;
                                user-entered: 25; ZIP-level estimate from ≥20 listings: 18, otherwise 10; none: 0)
    Property tax           15  (source value: 15, user-entered: 10, estimated from rate: 5)
    HOA / insurance        10  (HOA known: 5; insurance user-entered: 5, estimated: 2)
    Listing completeness   15  (beds, baths, sqft, year built, coordinates: 3 each)

Short-term rental replaces the rent line with
    STR revenue estimate   30  (property-level provider: 30, market-level provider: 20,
                                user-entered: 18, none: 0)
    STR legality           10  (verified permitted/restricted/prohibited: 10, unknown: 0)

Labels: High ≥ 75, Medium ≥ 55, Low ≥ 35, otherwise Insufficient Data.
Hard rules: no income estimate ⇒ Insufficient Data; unknown STR legality caps the
STR label at Medium; a listing not seen for 30+ days caps the label at Medium.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel

Provenance = Literal["verified", "estimated", "user", "unavailable"]
ConfidenceLabel = Literal["high", "medium", "low", "insufficient"]
RentSource = Literal["property_avm", "market_zip", "user", "none"]
StrSource = Literal["provider_property", "provider_market", "user", "none"]
TaxSource = Literal["source", "user", "estimated"]
Legality = Literal["permitted", "restricted", "prohibited", "unknown"]

LABEL_ORDER: dict[str, int] = {"insufficient": 0, "low": 1, "medium": 2, "high": 3}


class QualityInputs(BaseModel):
    listing_source: str | None = None
    listing_last_seen: datetime | None = None
    is_demo: bool = False
    rent_source: RentSource = "none"
    rent_provider: str | None = None
    rent_comp_count: int = 0
    rent_market_sample: int = 0
    rent_estimated_at: datetime | None = None
    tax_source: TaxSource = "estimated"
    hoa_known: bool = False
    insurance_user_entered: bool = False
    str_source: StrSource = "none"
    str_provider: str | None = None
    str_estimated_at: datetime | None = None
    str_legality: Legality = "unknown"
    str_legality_verified: bool = False
    has_beds: bool = False
    has_baths: bool = False
    has_sqft: bool = False
    has_year_built: bool = False
    has_coordinates: bool = False


class QualityFactor(BaseModel):
    key: str
    label: str
    points: int
    max_points: int
    detail: str
    provenance: Provenance


class QualityAssessment(BaseModel):
    strategy: Literal["ltr", "str"]
    score: int
    label: ConfidenceLabel
    factors: list[QualityFactor]
    caveats: list[str]
    is_demo: bool = False


def label_for(score: int) -> ConfidenceLabel:
    if score >= 75:
        return "high"
    if score >= 55:
        return "medium"
    if score >= 35:
        return "low"
    return "insufficient"


def _cap(label: ConfidenceLabel, ceiling: ConfidenceLabel) -> ConfidenceLabel:
    return label if LABEL_ORDER[label] <= LABEL_ORDER[ceiling] else ceiling


def _age_days(moment: datetime | None, now: datetime) -> int | None:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return max((now - moment).days, 0)


def _freshness(q: QualityInputs, now: datetime) -> tuple[QualityFactor, int | None]:
    age = _age_days(q.listing_last_seen, now)
    if age is None:
        points, detail, prov = 0, "Listing last-seen date unknown", "unavailable"
    elif age <= 2:
        points, detail, prov = 20, f"Listing confirmed {age} day(s) ago", "verified"
    elif age <= 7:
        points, detail, prov = 15, f"Listing confirmed {age} days ago", "verified"
    elif age <= 30:
        points, detail, prov = 8, f"Listing last confirmed {age} days ago", "verified"
    else:
        points, detail, prov = 0, f"Listing not confirmed for {age} days — may no longer be active", "estimated"
    source = f" via {q.listing_source}" if q.listing_source else ""
    return (
        QualityFactor(key="listing", label="Listing freshness", points=points, max_points=20, detail=detail + source, provenance=prov),  # type: ignore[arg-type]
        age,
    )


def _common(q: QualityInputs) -> list[QualityFactor]:
    tax_points = {"source": 15, "user": 10, "estimated": 5}[q.tax_source]
    tax_detail = {
        "source": "Property tax from listing / public record",
        "user": "Property tax entered by you",
        "estimated": "Property tax estimated from a rate × price — verify with the county",
    }[q.tax_source]
    tax_prov: Provenance = {"source": "verified", "user": "user", "estimated": "estimated"}[q.tax_source]  # type: ignore[assignment]

    carry = (5 if q.hoa_known else 0) + (5 if q.insurance_user_entered else 2)
    carry_detail = ("HOA fee reported by listing" if q.hoa_known else "HOA fee not reported — assumed $0") + (
        "; insurance entered by you" if q.insurance_user_entered else "; insurance estimated from a rate × price"
    )

    present = [q.has_beds, q.has_baths, q.has_sqft, q.has_year_built, q.has_coordinates]
    missing = [
        name
        for name, ok in zip(("bedrooms", "bathrooms", "square footage", "year built", "coordinates"), present, strict=True)
        if not ok
    ]
    return [
        QualityFactor(key="tax", label="Property tax", points=tax_points, max_points=15, detail=tax_detail, provenance=tax_prov),
        QualityFactor(
            key="carry",
            label="HOA & insurance",
            points=carry,
            max_points=10,
            detail=carry_detail,
            provenance="verified" if q.hoa_known else "estimated",
        ),
        QualityFactor(
            key="completeness",
            label="Listing completeness",
            points=3 * sum(present),
            max_points=15,
            detail="All key listing fields present" if not missing else "Missing: " + ", ".join(missing),
            provenance="verified" if not missing else "unavailable",
        ),
    ]


def assess_ltr(q: QualityInputs, now: datetime | None = None) -> QualityAssessment:
    now = now or datetime.now(UTC)
    freshness, age = _freshness(q, now)
    caveats: list[str] = []

    provider = q.rent_provider or "provider"
    if q.rent_source == "property_avm":
        points = 40 if q.rent_comp_count >= 5 else 30 if q.rent_comp_count >= 3 else 20
        detail = f"Property-level rent estimate from {provider} using {q.rent_comp_count} comparable(s)"
        prov: Provenance = "estimated"
        if q.rent_comp_count < 3:
            caveats.append("Rent estimate is based on fewer than 3 comparables.")
    elif q.rent_source == "user":
        points, detail, prov = 25, "Monthly rent entered by you", "user"
    elif q.rent_source == "market_zip":
        points = 18 if q.rent_market_sample >= 20 else 10
        detail = f"Conservative ZIP-level rent estimate from {provider} market statistics ({q.rent_market_sample} listings) — not specific to this property"
        prov = "estimated"
        caveats.append("Rent is a ZIP-level screening estimate, not a property-specific one. Request a detailed estimate before relying on it.")
    else:
        points, detail, prov = 0, "No rent estimate available", "unavailable"

    factors = [freshness, QualityFactor(key="rent", label="Rent estimate", points=points, max_points=40, detail=detail, provenance=prov), *_common(q)]
    score = sum(f.points for f in factors)
    label = label_for(score)
    if q.rent_source == "none":
        label = "insufficient"
        caveats.append("No rent estimate — long-term rental returns cannot be calculated.")
    if age is None or age > 30:
        label = _cap(label, "medium")
        caveats.append("Listing status could not be confirmed recently; verify the property is still for sale.")
    if q.tax_source == "estimated":
        caveats.append("Property tax is an estimate and often resets after a sale.")
    return QualityAssessment(strategy="ltr", score=score, label=label, factors=factors, caveats=caveats, is_demo=q.is_demo)


def assess_str(q: QualityInputs, now: datetime | None = None) -> QualityAssessment:
    now = now or datetime.now(UTC)
    freshness, age = _freshness(q, now)
    caveats: list[str] = []

    provider = q.str_provider or "provider"
    if q.str_source == "provider_property":
        points, detail, prov = 30, f"Property-level short-term rental estimate from {provider}", "estimated"
    elif q.str_source == "provider_market":
        points, detail, prov = 20, f"Market-level short-term rental averages from {provider}", "estimated"
        caveats.append("STR revenue is a market average, not specific to this property.")
    elif q.str_source == "user":
        points, detail, prov = 18, "Daily rate and occupancy entered by you", "user"
    else:
        points, detail, prov = 0, "No short-term rental estimate available", "unavailable"

    if q.str_legality_verified and q.str_legality != "unknown":
        legal = QualityFactor(key="legality", label="STR legality", points=10, max_points=10, detail=f"Local rules recorded as: {q.str_legality}", provenance="verified")
    else:
        legal = QualityFactor(key="legality", label="STR legality", points=0, max_points=10, detail="Local short-term rental rules have not been verified", provenance="unavailable")
        caveats.append("Short-term rental legality is unverified. Confirm zoning, permits and HOA rules before relying on STR income.")

    factors = [
        freshness,
        QualityFactor(key="str_revenue", label="STR revenue estimate", points=points, max_points=30, detail=detail, provenance=prov),  # type: ignore[arg-type]
        legal,
        *_common(q),
    ]
    score = sum(f.points for f in factors)
    label = label_for(score)
    if q.str_source == "none":
        label = "insufficient"
        caveats.append("No STR revenue estimate — short-term rental returns cannot be calculated.")
    if not (q.str_legality_verified and q.str_legality != "unknown"):
        label = _cap(label, "medium")
    if age is None or age > 30:
        label = _cap(label, "medium")
    return QualityAssessment(strategy="str", score=score, label=label, factors=factors, caveats=caveats, is_demo=q.is_demo)
