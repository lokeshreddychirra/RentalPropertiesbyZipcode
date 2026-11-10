from datetime import UTC, datetime, timedelta
from decimal import Decimal as D

from app.finance.engine import analyze_strategy
from app.finance.inputs import Acquisition, Assumptions, Financing, LongTermRental, ShortTermRental
from app.finance.quality import QualityInputs, assess_ltr, assess_str
from app.finance.scoring import ScoreWeights, linear, recommend, score_strategy

NOW = datetime(2026, 6, 1, tzinfo=UTC)


def assumptions(rent="2600", price="220000", adr="190", occ="62") -> Assumptions:
    return Assumptions(
        acquisition=Acquisition(purchase_price=D(price)),
        financing=Financing(),
        long_term=LongTermRental(monthly_rent=D(rent) if rent else None),
        short_term=ShortTermRental(adr=D(adr) if adr else None, occupancy_pct=D(occ) if occ else None, furnishing_cost=D("15000")),
    )


def strong_quality(**kw) -> QualityInputs:
    data = dict(
        listing_source="RentCast",
        listing_last_seen=NOW - timedelta(days=1),
        rent_source="property_avm",
        rent_comp_count=8,
        tax_source="source",
        hoa_known=True,
        str_source="provider_property",
        str_legality="permitted",
        str_legality_verified=True,
        has_beds=True,
        has_baths=True,
        has_sqft=True,
        has_year_built=True,
        has_coordinates=True,
    )
    data.update(kw)
    return QualityInputs(**data)


def test_linear_normalisation_clamps():
    assert linear(D("6"), D("0"), D("12")) == 50
    assert linear(D("-3"), D("0"), D("12")) == 0
    assert linear(D("40"), D("0"), D("12")) == 100
    assert linear(D("80"), D("100"), D("60")) == 50  # inverted scale
    assert linear(None, D("0"), D("12")) == 0


def test_quality_labels():
    assert assess_ltr(strong_quality(), NOW).label == "high"
    assert assess_ltr(strong_quality(), NOW).score == 97
    zip_level = assess_ltr(strong_quality(rent_source="market_zip", rent_market_sample=40, tax_source="estimated", hoa_known=False), NOW)
    assert zip_level.label == "medium" and zip_level.score == 60
    weak = assess_ltr(QualityInputs(rent_source="market_zip", rent_market_sample=5, listing_last_seen=NOW - timedelta(days=20)), NOW)
    assert weak.label == "insufficient"
    assert assess_ltr(strong_quality(rent_source="none"), NOW).label == "insufficient"
    stale = assess_ltr(strong_quality(listing_last_seen=NOW - timedelta(days=45)), NOW)
    assert stale.label == "medium"  # capped: listing may no longer be active


def test_str_quality_capped_when_legality_unverified():
    verified = assess_str(strong_quality(), NOW)
    assert verified.label == "high"
    unverified = assess_str(strong_quality(str_legality="unknown", str_legality_verified=False), NOW)
    assert unverified.label == "medium"
    assert any("unverified" in c for c in unverified.caveats)
    assert assess_str(strong_quality(str_source="none"), NOW).label == "insufficient"


def test_score_weights_are_normalised_and_bounded():
    result = analyze_strategy(assumptions(), "ltr")
    quality = assess_ltr(strong_quality(), NOW)
    default = score_strategy(result, quality, ScoreWeights(), days_on_market=12)
    doubled = score_strategy(result, quality, ScoreWeights(**{k: v * 2 for k, v in ScoreWeights().model_dump().items()}), days_on_market=12)
    assert default.score == doubled.score
    assert 0 <= default.score <= 100
    assert abs(sum(c.contribution for c in default.components) - default.uncapped_score) <= D("0.4")
    assert sum(c.weight_pct for c in default.components) == 100
    only_cap = score_strategy(result, quality, ScoreWeights(cash_on_cash=0, cap_rate=100, cash_flow=0, dscr=0, rent_confidence=0, market_risk=0, data_quality=0))
    assert only_cap.score == linear(result.cap_rate_pct, D("3"), D("10")).quantize(D("0.1"))


def test_weak_data_cannot_rank_strongly():
    result = analyze_strategy(assumptions(rent="4000"), "ltr")  # spectacular numbers
    good = score_strategy(result, assess_ltr(strong_quality(), NOW), ScoreWeights(), days_on_market=5)
    poor_quality = assess_ltr(QualityInputs(rent_source="market_zip", rent_market_sample=3), NOW)
    assert poor_quality.label == "insufficient"
    capped = score_strategy(result, poor_quality, ScoreWeights(), days_on_market=5)
    assert good.score > 85
    assert capped.score == 40 and capped.cap_applied


def test_unavailable_strategy_is_unranked():
    result = analyze_strategy(assumptions(rent=None), "ltr")
    assert score_strategy(result, assess_ltr(strong_quality(rent_source="none"), NOW), ScoreWeights()).score is None


def test_prohibited_str_scores_zero_and_is_never_recommended():
    a = assumptions(rent="1500", adr="320", occ="75")
    ltr, st = analyze_strategy(a, "ltr"), analyze_strategy(a, "str")
    assert st.cash_on_cash_pct > ltr.cash_on_cash_pct
    score = score_strategy(st, assess_str(strong_quality(str_legality="prohibited"), NOW), ScoreWeights(), legality="prohibited")
    assert score.score == 0
    rec = recommend(ltr, st, "prohibited")
    assert rec.strategy == "ltr" and "prohibited" in rec.reasons[0]


def test_recommendation_conditional_when_legality_unknown():
    a = assumptions(rent="1500", adr="320", occ="75")
    ltr, st = analyze_strategy(a, "ltr"), analyze_strategy(a, "str")
    unknown = recommend(ltr, st, "unknown")
    assert unknown.strategy == "str" and unknown.conditional and "verif" in unknown.headline
    permitted = recommend(ltr, st, "permitted")
    assert permitted.strategy == "str" and not permitted.conditional
    restricted = recommend(ltr, st, "restricted")
    assert restricted.conditional and "restricted" in restricted.reasons[-1]


def test_recommendation_prefers_ltr_when_stronger_or_comparable():
    a = assumptions(rent="2600", adr="120", occ="45")
    assert recommend(analyze_strategy(a, "ltr"), analyze_strategy(a, "str"), "permitted").strategy == "ltr"
    none = recommend(analyze_strategy(assumptions(rent=None, adr=None), "ltr"), analyze_strategy(assumptions(rent=None, adr=None), "str"), "unknown")
    assert none.strategy is None


def test_database_url_from_managed_hosts_is_normalised():
    from app.core.config import Settings

    assert Settings(database_url="postgres://u:p@host/db").database_url == "postgresql+asyncpg://u:p@host/db"
    assert Settings(database_url="postgresql://u:p@host:5432/db?sslmode=require").database_url == "postgresql+asyncpg://u:p@host:5432/db?ssl=require"
    assert Settings(database_url="postgresql+asyncpg://u:p@host/db").database_url == "postgresql+asyncpg://u:p@host/db"
