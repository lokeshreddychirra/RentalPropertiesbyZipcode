"""Deterministic investment analysis, comparison, scenarios and the grounded AI explanation."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, Session, rate_limit
from app.core.config import get_settings
from app.core.errors import NotFoundError
from app.finance.results import ScenarioResult, SensitivityResult
from app.finance.scoring import ScoreWeights
from app.models.tables import InvestmentAnalysis, Property
from app.schemas.analysis import AnalysisRequest, AssumptionOverrides, PropertyAnalysis, PropertyContext
from app.services import property_store
from app.services.ai_analyst import AIExplanationResponse, explain
from app.services.analysis import analyze, analyze_request

router = APIRouter(prefix="/analysis", tags=["analysis"])


async def _context(session: Session, property_id: uuid.UUID | None) -> PropertyContext | None:
    if property_id is None:
        return None
    ctx = await property_store.load_context(session, property_id)
    if ctx is None:
        raise NotFoundError("Property not found")
    return ctx


@router.post("/calculate", response_model=PropertyAnalysis)
async def calculate(body: AnalysisRequest, session: Session) -> PropertyAnalysis:
    """Run the financial model for a stored property (or ad-hoc assumptions).

    Send only the assumptions you want to change in `overrides`; the response echoes the full resolved
    assumption set and a `provenance` map marking each input as verified, estimated, default or user-entered.
    Use `include` to add forecasts, scenarios, sensitivity tables and financing comparisons.
    """
    return analyze_request(await _context(session, body.property_id), body)


class CompareRequest(BaseModel):
    property_ids: list[uuid.UUID] = Field(min_length=1, max_length=5)
    defaults: AssumptionOverrides | None = None  # type: ignore[valid-type]
    overrides_by_property: dict[uuid.UUID, AssumptionOverrides] = Field(default_factory=dict)  # type: ignore[valid-type]
    weights: ScoreWeights | None = None


class CompareItem(BaseModel):
    context: PropertyContext
    analysis: PropertyAnalysis


class CompareMetric(BaseModel):
    key: str
    label: str
    unit: str  # currency | percent | ratio | score | text
    better: str  # higher | lower | none
    strategy: str | None = None
    values: list[float | str | None]
    best_index: int | None = None


class CompareResponse(BaseModel):
    items: list[CompareItem]
    metrics: list[CompareMetric]
    missing: list[uuid.UUID] = []


def _ten_year(analysis: PropertyAnalysis, strategy: str, attr: str) -> float | None:
    fc = analysis.forecast_ltr if strategy == "ltr" else analysis.forecast_str
    if fc is None or not fc.available:
        return None
    horizon = next((h for h in fc.horizons if h.years == 10), None)
    value = getattr(horizon, attr) if horizon else None
    return float(value) if value is not None else None


_RISK_ORDER = {"high": 3, "medium": 2, "low": 1, "insufficient": 0}


def _metrics(items: list[CompareItem]) -> list[CompareMetric]:
    def f(value: Any) -> float | None:
        return float(value) if value is not None else None

    rows: list[tuple[str, str, str, str, str | None, list[Any]]] = [
        ("price", "Purchase price", "currency", "lower", None, [f(i.analysis.assumptions.acquisition.purchase_price) for i in items]),
        ("score", "Investment score", "score", "higher", None, [f(i.analysis.overall_score) for i in items]),
    ]
    for strategy, label in (("ltr", ""),):
        def r(item: CompareItem, strategy: str = strategy) -> Any:
            return item.analysis.long_term if strategy == "ltr" else item.analysis.short_term

        rows += [
            (f"{strategy}_income", f"{label} monthly {'rent' if strategy == 'ltr' else 'revenue'}", "currency", "higher", strategy, [f(r(i).gross_monthly_income) for i in items]),
            (f"{strategy}_gross_yield", f"{label} gross yield", "percent", "higher", strategy, [f(r(i).gross_yield_pct) for i in items]),
            (f"{strategy}_expenses", f"{label} operating expenses / yr", "currency", "lower", strategy, [f(r(i).operating_expenses_annual) for i in items]),
            (f"{strategy}_cap_rate", f"{label} cap rate", "percent", "higher", strategy, [f(r(i).cap_rate_pct) for i in items]),
            (f"{strategy}_cash_flow", f"{label} monthly cash flow", "currency", "higher", strategy, [f(r(i).monthly_cash_flow) for i in items]),
            (f"{strategy}_coc", f"{label} cash-on-cash", "percent", "higher", strategy, [f(r(i).cash_on_cash_pct) for i in items]),
            (f"{strategy}_dscr", f"{label} DSCR", "ratio", "higher", strategy, [f(r(i).dscr) if r(i).available and r(i).dscr is not None else ("N/A (cash)" if r(i).available else None) for i in items]),
            (f"{strategy}_upfront", f"{label} upfront cash", "currency", "lower", strategy, [f(r(i).total_cash_invested) for i in items]),
            (f"{strategy}_break_even", f"{label} break-even occupancy", "percent", "lower", strategy, [f(r(i).break_even_occupancy_pct) for i in items]),
            (f"{strategy}_10y_profit", f"{label} 10-year total profit (forecast)", "currency", "higher", strategy, [_ten_year(i.analysis, strategy, "total_profit") for i in items]),
            (f"{strategy}_10y_irr", f"{label} 10-year IRR (forecast)", "percent", "higher", strategy, [_ten_year(i.analysis, strategy, "irr_pct") for i in items]),
        ]
    rows += [
        ("confidence", "Data confidence", "text", "higher", None, [i.analysis.confidence for i in items]),
    ]

    metrics: list[CompareMetric] = []
    for key, label, unit, better, strategy, values in rows:
        label = label.strip()
        label = label[:1].upper() + label[1:]
        best: int | None = None
        if better != "none" and len(items) > 1:
            if key == "confidence":
                ranked = [(_RISK_ORDER.get(str(v), -1), idx) for idx, v in enumerate(values)]
                top = max(ranked)[0]
                winners = [idx for score, idx in ranked if score == top]
                best = winners[0] if len(winners) == 1 else None
            else:
                numeric = [(v, idx) for idx, v in enumerate(values) if isinstance(v, int | float)]
                if numeric:
                    target = (max if better == "higher" else min)(v for v, _ in numeric)
                    winners = [idx for v, idx in numeric if v == target]
                    best = winners[0] if len(winners) == 1 else None
        metrics.append(CompareMetric(key=key, label=label, unit=unit, better=better, strategy=strategy, values=values, best_index=best))
    return metrics


@router.post("/compare", response_model=CompareResponse)
async def compare(body: CompareRequest, session: Session) -> CompareResponse:
    """Compare up to five properties side by side. `best_index` marks the strongest value per metric
    (respecting whether higher or lower is better); ties and missing values are not highlighted."""
    contexts = await property_store.load_contexts(session, body.property_ids)
    items: list[CompareItem] = []
    missing: list[uuid.UUID] = []
    for property_id in dict.fromkeys(body.property_ids):
        ctx = contexts.get(property_id)
        if ctx is None:
            missing.append(property_id)
            continue
        analysis = analyze(ctx, overrides=body.overrides_by_property.get(property_id), defaults=body.defaults, weights=body.weights, include=["forecast"])
        items.append(CompareItem(context=ctx, analysis=analysis))
    return CompareResponse(items=items, metrics=_metrics(items), missing=missing)


class ScenariosResponse(BaseModel):
    scenarios_ltr: list[ScenarioResult]
    scenarios_str: list[ScenarioResult]
    sensitivity_ltr: SensitivityResult
    sensitivity_str: SensitivityResult


@router.post("/scenarios", response_model=ScenariosResponse)
async def scenario_analysis(body: AnalysisRequest, session: Session) -> ScenariosResponse:
    """Conservative / base / optimistic cases plus sensitivity tables for both strategies."""
    analysis = analyze(
        await _context(session, body.property_id), overrides=body.overrides, defaults=body.defaults, weights=body.weights, include=["scenarios", "sensitivity"]
    )
    return ScenariosResponse(
        scenarios_ltr=analysis.scenarios_ltr or [],
        scenarios_str=analysis.scenarios_str or [],
        sensitivity_ltr=analysis.sensitivity_ltr,  # type: ignore[arg-type]
        sensitivity_str=analysis.sensitivity_str,  # type: ignore[arg-type]
    )


@router.post("/ai-explanation", response_model=AIExplanationResponse, dependencies=[rate_limit("ai", 20, 60)])
async def ai_explanation(body: AnalysisRequest, session: Session) -> AIExplanationResponse:
    """Plain-language explanation of the calculated analysis.

    The LLM only sees values produced by the deterministic engine and sourced listing data, and its
    output is rejected if it quotes any figure that cannot be traced back to them.
    """
    ctx = await _context(session, body.property_id)
    analysis = analyze(ctx, overrides=body.overrides, defaults=body.defaults, weights=body.weights)
    return await explain(ctx, analysis, get_settings().llm_model)


# --------------------------------------------------------------------------- saved evaluations


class SaveAnalysisRequest(BaseModel):
    property_id: uuid.UUID
    name: str | None = Field(default=None, max_length=120)
    overrides: AssumptionOverrides | None = None  # type: ignore[valid-type]
    defaults: AssumptionOverrides | None = None  # type: ignore[valid-type]
    weights: ScoreWeights | None = None


class SavedAnalysisOut(BaseModel):
    id: uuid.UUID
    property_id: uuid.UUID
    address: str
    name: str | None
    overrides: dict[str, Any]
    summary: dict[str, Any]
    recommended_strategy: str | None
    score: float | None
    created_at: datetime


def _saved_out(row: InvestmentAnalysis, address: str) -> SavedAnalysisOut:
    return SavedAnalysisOut(
        id=row.id, property_id=row.property_id, address=address, name=row.name, overrides=row.overrides, summary=row.summary,
        recommended_strategy=row.recommended_strategy, score=float(row.score) if row.score is not None else None, created_at=row.created_at,
    )


@router.post("/saved", response_model=SavedAnalysisOut, status_code=201)
async def save_analysis(body: SaveAnalysisRequest, user: CurrentUser, session: Session) -> SavedAnalysisOut:
    """Save an evaluation (assumptions + headline results) so it can be reviewed later."""
    ctx = await _context(session, body.property_id)
    assert ctx is not None
    analysis = analyze(ctx, overrides=body.overrides, defaults=body.defaults, weights=body.weights)

    def brief(result: Any) -> dict[str, Any]:
        return result.model_dump(mode="json", include={"available", "gross_monthly_income", "gross_yield_pct", "cap_rate_pct", "monthly_cash_flow", "cash_on_cash_pct", "dscr", "total_cash_invested", "noi_annual"})

    # Merge standing defaults and property overrides so the evaluation can be reproduced exactly.
    merged: dict[str, Any] = body.defaults.model_dump(mode="json", exclude_none=True) if body.defaults else {}
    for section, fields in (body.overrides.model_dump(mode="json", exclude_unset=True) if body.overrides else {}).items():
        if isinstance(fields, dict):
            merged.setdefault(section, {}).update(fields)
    row = InvestmentAnalysis(
        user_id=user.id,
        property_id=body.property_id,
        name=body.name,
        overrides=merged,
        assumptions=analysis.assumptions.model_dump(mode="json"),
        summary={"long_term": brief(analysis.long_term), "short_term": brief(analysis.short_term), "confidence": analysis.confidence, "recommendation": analysis.recommendation.headline, "price": float(analysis.assumptions.acquisition.purchase_price)},
        recommended_strategy=analysis.primary_strategy,
        score=analysis.overall_score,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return _saved_out(row, ctx.formatted_address)


@router.get("/saved", response_model=list[SavedAnalysisOut])
async def list_saved_analyses(user: CurrentUser, session: Session) -> list[SavedAnalysisOut]:
    rows = (
        await session.execute(
            select(InvestmentAnalysis, Property.formatted_address)
            .join(Property, Property.id == InvestmentAnalysis.property_id)
            .where(InvestmentAnalysis.user_id == user.id)
            .order_by(InvestmentAnalysis.created_at.desc())
            .limit(200)
        )
    ).all()
    return [_saved_out(row, address) for row, address in rows]


@router.delete("/saved/{analysis_id}", status_code=204)
async def delete_saved_analysis(analysis_id: uuid.UUID, user: CurrentUser, session: Session) -> None:
    row = await session.get(InvestmentAnalysis, analysis_id)
    if row is None or row.user_id != user.id:
        raise NotFoundError("Saved analysis not found")
    await session.delete(row)
