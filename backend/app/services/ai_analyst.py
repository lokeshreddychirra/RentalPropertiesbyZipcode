"""AI investment analyst.

Grounding rules:

1. The model is given a *facts sheet* built only from deterministic engine output
   and sourced property data, and is told to use nothing else.
2. Its response is schema-validated, then every number it wrote is checked against
   the facts sheet. If any figure cannot be traced to a provided fact, the LLM
   text is discarded and the deterministic rule-based explanation is returned
   instead (the response says which engine produced it).
3. With no LLM configured, the rule-based explanation is used directly.

So the LLM can explain results, but can never introduce a metric, a listing fact,
a legal permission or a comparable that the application did not calculate or source.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.finance.engine import analyze_strategy
from app.schemas.analysis import PropertyAnalysis, PropertyContext

from .llm import LLMUnavailable, generate_structured


class AIExplanation(BaseModel):
    summary: str = Field(description="Two or three sentences: is this attractive and why, with the key figures")
    attractive_points: list[str] = Field(description="Why the property may be attractive")
    cash_flow: str = Field(description="Expected cash flow under the stated financing assumptions")
    strategy_comparison: str = Field(description="One or two sentences on the long-term rental outlook: rent coverage of costs and what would improve returns")
    strengths: list[str] = Field(description="Financial strengths")
    risks: list[str] = Field(description="Financial risks")
    sensitivity: str = Field(description="Sensitivity to mortgage rate and vacancy using the provided stress figures")
    missing_information: list[str] = Field(description="Missing or estimated information requiring verification")
    due_diligence_questions: list[str] = Field(description="Questions to answer before buying")


class AIExplanationResponse(BaseModel):
    engine: Literal["llm", "rules"]
    model: str | None = None
    explanation: AIExplanation
    grounded: bool = True
    note: str | None = None
    disclaimer: str = "Generated explanation of calculated estimates — not financial, legal or tax advice. Verify all figures before investing."
    is_demo: bool = False


# --------------------------------------------------------------------------- facts


def _n(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    return value


def _strategy_facts(result: Any) -> dict[str, Any]:
    if not result.available:
        return {"available": False, "reason": result.unavailable_reason}
    facts = {
        "available": True,
        "gross_annual_income": _n(result.gross_annual_income),
        "gross_monthly_income": _n(result.gross_monthly_income),
        "gross_yield_pct": _n(result.gross_yield_pct),
        "operating_expenses_annual": _n(result.operating_expenses_annual),
        "expense_ratio_pct": _n(result.expense_ratio_pct),
        "noi_annual": _n(result.noi_annual),
        "cap_rate_pct": _n(result.cap_rate_pct),
        "net_yield_pct": _n(result.net_yield_pct),
        "annual_debt_service": _n(result.annual_debt_service),
        "monthly_cash_flow": _n(result.monthly_cash_flow),
        "annual_cash_flow": _n(result.annual_cash_flow),
        "cash_on_cash_pct": _n(result.cash_on_cash_pct),
        "dscr": _n(result.dscr) if result.dscr is not None else "not applicable (cash purchase)",
        "break_even_occupancy_pct": _n(result.break_even_occupancy_pct),
        "total_cash_invested": _n(result.total_cash_invested),
    }
    if result.str_detail:
        facts.update(
            average_daily_rate=_n(result.str_detail.adr),
            occupancy_pct=_n(result.str_detail.occupancy_pct),
            booked_nights=_n(result.str_detail.booked_nights),
        )
    return facts


def _stress(analysis: PropertyAnalysis) -> dict[str, Any]:
    """Deterministic stress figures the explanation may quote."""
    a = analysis.assumptions
    out: dict[str, Any] = {}
    if not a.financing.is_cash:
        up = a.model_copy(deep=True)
        up.financing.interest_rate_pct = a.financing.interest_rate_pct + Decimal("1")
        result = analyze_strategy(up, "ltr")
        if result.available:
            out["long_term_monthly_cash_flow_if_rate_plus_1pt"] = _n(result.monthly_cash_flow)
        out["rate_plus_1pt_pct"] = _n(up.financing.interest_rate_pct)
    if analysis.long_term.available:
        vac = a.model_copy(deep=True)
        vac.long_term.vacancy_pct = min(a.long_term.vacancy_pct + Decimal("5"), Decimal("100"))
        out["long_term_monthly_cash_flow_if_vacancy_plus_5pts"] = _n(analyze_strategy(vac, "ltr").monthly_cash_flow)
        out["stressed_vacancy_pct"] = _n(vac.long_term.vacancy_pct)
    return out


def build_facts(ctx: PropertyContext | None, analysis: PropertyAnalysis) -> dict[str, Any]:
    a = analysis.assumptions
    estimated = sorted(path for path, source in analysis.provenance.items() if source in ("estimated", "unavailable") and path in _KEY_INPUTS)
    facts: dict[str, Any] = {
        "property": {
            "address": ctx.formatted_address if ctx else "Custom scenario",
            "type": ctx.property_type if ctx else None,
            "bedrooms": _n(ctx.bedrooms) if ctx else None,
            "bathrooms": _n(ctx.bathrooms) if ctx else None,
            "square_feet": ctx.square_feet if ctx else None,
            "year_built": ctx.year_built if ctx else None,
            "days_on_market": ctx.days_on_market if ctx else None,
            "is_demo_sample_data": bool(ctx and ctx.is_demo),
            "price_reduction": {"previous_price": _n(ctx.price_reduction.previous_price), "percent": _n(ctx.price_reduction.percent)} if ctx and ctx.price_reduction else None,
            "value_estimate": _n(ctx.value_estimate) if ctx and ctx.value_estimate else None,
        },
        "assumptions": {
            "purchase_price": _n(a.acquisition.purchase_price),
            "down_payment_pct": _n(a.financing.down_payment_pct),
            "interest_rate_pct": _n(a.financing.interest_rate_pct),
            "loan_term_years": a.financing.loan_term_years,
            "all_cash": a.financing.is_cash,
            "monthly_rent": _n(a.long_term.monthly_rent),
            "vacancy_pct": _n(a.long_term.vacancy_pct),
            "property_tax_annual": _n(next((e.annual for e in analysis.long_term.expenses if e.key == "property_tax"), None)),
            "hoa_monthly": _n(a.fixed.hoa_monthly),
        },
        "loan": {"loan_amount": _n(analysis.loan.loan_amount), "monthly_payment": _n(analysis.loan.monthly_principal_interest + analysis.loan.monthly_pmi)},
        "long_term_rental": _strategy_facts(analysis.long_term),
        "investment_score": {"overall": _n(analysis.overall_score), "cap_note": analysis.score_ltr.cap_applied},
        "data_quality": {
            "long_term": {"label": analysis.quality_ltr.label, "score": analysis.quality_ltr.score, "caveats": analysis.quality_ltr.caveats},
            "rent_estimate_source": (f"{ctx.rent.source} from {ctx.rent.provider}, {ctx.rent.comp_count} comparables" if ctx and ctx.rent else "none"),
            "estimated_or_missing_inputs": estimated,
        },
        "stress_tests": _stress(analysis),
    }
    return facts


_KEY_INPUTS = {"fixed.property_tax_annual", "fixed.insurance_annual", "fixed.hoa_monthly", "long_term.monthly_rent"}
_INPUT_LABELS = {
    "fixed.property_tax_annual": "Property tax is estimated from a rate and may reset after the sale",
    "fixed.insurance_annual": "Insurance is estimated from a rate — get a landlord policy quote",
    "fixed.hoa_monthly": "HOA fee was not reported by the listing and is assumed to be $0",
    "long_term.monthly_rent": "Long-term rent is an estimate, not a signed lease",
}


# --------------------------------------------------------------------------- grounding check

_NUMBER = re.compile(r"-?\$?\d[\d,]*(?:\.\d+)?")


def _collect_numbers(value: Any, out: set[Decimal]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, int | float | Decimal):
        out.add(Decimal(str(value)))
    elif isinstance(value, str):
        for token in _NUMBER.findall(value):
            cleaned = token.replace("$", "").replace(",", "")
            if cleaned not in ("", "-"):
                out.add(Decimal(cleaned))
    elif isinstance(value, dict):
        for item in value.values():
            _collect_numbers(item, out)
    elif isinstance(value, list | tuple):
        for item in value:
            _collect_numbers(item, out)


def ungrounded_numbers(explanation: AIExplanation, facts: dict[str, Any]) -> list[str]:
    """Numbers in the explanation that do not correspond to any provided fact.

    A number is accepted when it equals a fact (or its absolute value) after
    rounding to the precision the model used. Bare small counts (≤ 12, e.g.
    "3 comparables", "12 months") are allowed; anything written as money, a
    decimal or a percentage must match a fact.
    """
    allowed: set[Decimal] = set()
    _collect_numbers(facts, allowed)
    allowed |= {abs(v) for v in allowed}
    text = " ".join(
        [explanation.summary, explanation.cash_flow, explanation.strategy_comparison, explanation.sensitivity]
        + explanation.attractive_points + explanation.strengths + explanation.risks + explanation.missing_information + explanation.due_diligence_questions
    )
    bad: list[str] = []
    for match in re.finditer(r"(?<![A-Za-z])-?\$?\d[\d,]*(?:\.\d+)?(?:\s?[kK]\b)?", text):
        token = match.group(0)
        thousands = token.rstrip().lower().endswith("k")
        cleaned = token.replace("$", "").replace(",", "").rstrip("kK ").strip()
        if cleaned in ("", "-"):
            continue
        value = abs(Decimal(cleaned)) * (1000 if thousands else 1)
        # Plain small counts ("3 comparables", "12 months") are not financial figures.
        # Anything written as money or a percentage must always trace to a fact.
        is_metric = "$" in token or "." in cleaned or thousands or text[match.end() : match.end() + 9].lstrip().startswith(("%", "percent", "pts", "point"))
        if not is_metric and (value <= 12 or value == 100):
            continue
        places = 0 if thousands or "." not in cleaned else len(cleaned.split(".")[1])
        quantum = Decimal(1).scaleb(-places)
        tolerance = Decimal(500) if thousands else quantum / 2
        if not any(abs(candidate - value) <= tolerance for candidate in allowed):
            bad.append(token.strip())
    return bad


# --------------------------------------------------------------------------- rule-based engine


def _usd(value: Any) -> str:
    if value is None:
        return "n/a"
    number = Decimal(str(value))
    return f"-${abs(number):,.0f}" if number < 0 else f"${number:,.0f}"


def rule_based_explanation(ctx: PropertyContext | None, analysis: PropertyAnalysis, facts: dict[str, Any]) -> AIExplanation:
    ltr = analysis.long_term
    a = analysis.assumptions
    financing = "an all-cash purchase" if a.financing.is_cash else f"{a.financing.down_payment_pct.normalize():f}% down at {a.financing.interest_rate_pct.normalize():f}% over {a.financing.loan_term_years} years"
    stress = facts["stress_tests"]
    attractive: list[str] = []
    strengths: list[str] = []
    risks: list[str] = []

    if ltr.available:
        if ltr.gross_yield_pct >= 8:
            attractive.append(f"Long-term gross rental yield of {ltr.gross_yield_pct}% is above the 8% high-yield threshold.")
        if ltr.monthly_cash_flow > 0:
            strengths.append(f"Positive long-term cash flow of {_usd(ltr.monthly_cash_flow)}/month after debt service.")
        else:
            risks.append(f"Long-term rental cash flow is negative at {_usd(ltr.monthly_cash_flow)}/month under {financing}.")
        if ltr.dscr is not None:
            (strengths if ltr.dscr >= Decimal("1.25") else risks).append(
                f"Long-term DSCR is {ltr.dscr}× ({'comfortably covers' if ltr.dscr >= Decimal('1.25') else 'leaves little or no cushion over'} debt service; lenders commonly look for about 1.2–1.25×)."
            )
        if ltr.break_even_occupancy_pct is not None:
            (risks if ltr.break_even_occupancy_pct > 90 else strengths).append(f"Long-term break-even occupancy is {ltr.break_even_occupancy_pct}%.")
        if ltr.cap_rate_pct >= 6:
            strengths.append(f"Cap rate of {ltr.cap_rate_pct}% on the asking price.")
    if ctx and ctx.price_reduction:
        attractive.append(f"Asking price was reduced {ctx.price_reduction.percent}% from {_usd(ctx.price_reduction.previous_price)}.")
    if ctx and ctx.value_estimate and ctx.price and ctx.value_estimate > ctx.price:
        attractive.append(f"List price of {_usd(ctx.price)} is below the {_usd(ctx.value_estimate)} automated value estimate.")
    if ctx and ctx.days_on_market is not None and ctx.days_on_market > 90:
        risks.append(f"The listing has been on the market for {ctx.days_on_market} days, which can indicate pricing or condition issues.")
    if not attractive:
        attractive.append("No standout strengths were identified under the current assumptions.")

    primary = ltr
    if primary.available:
        summary = (
            f"Under {financing}, the long-term rental scenario shows a {primary.gross_yield_pct}% gross yield, "
            f"a {primary.cap_rate_pct}% cap rate and {_usd(primary.monthly_cash_flow)}/month cash flow "
            f"({primary.cash_on_cash_pct}% cash-on-cash on {_usd(primary.total_cash_invested)} invested). "
            f"Data confidence is {analysis.confidence}."
        )
    else:
        summary = "There is not enough rental income data to evaluate this property. Enter a monthly rent to model returns."

    if ltr.available:
        cash_flow = f"Long-term: NOI of {_usd(ltr.noi_annual)}/year less {_usd(ltr.annual_debt_service)} of debt service leaves {_usd(ltr.monthly_cash_flow)}/month."
    else:
        cash_flow = "Long-term cash flow cannot be calculated without a rent estimate."

    if ltr.available and ltr.monthly_cash_flow > 0:
        comparison = f"Rent covers all costs including the mortgage, leaving {_usd(ltr.monthly_cash_flow)}/month."
    elif ltr.available:
        comparison = "Rent does not cover all costs under these assumptions. A lower price, a larger down payment or a higher rent would improve returns."
    else:
        comparison = "Enter a monthly rent to see the long-term rental outlook."

    parts: list[str] = []
    if "long_term_monthly_cash_flow_if_rate_plus_1pt" in stress:
        parts.append(f"A mortgage rate of {stress['rate_plus_1pt_pct']}% (one point higher) would change long-term cash flow to {_usd(stress['long_term_monthly_cash_flow_if_rate_plus_1pt'])}/month.")
    if "long_term_monthly_cash_flow_if_vacancy_plus_5pts" in stress:
        parts.append(f"Vacancy of {stress['stressed_vacancy_pct']}% (five points higher) would change it to {_usd(stress['long_term_monthly_cash_flow_if_vacancy_plus_5pts'])}/month.")
    if a.financing.is_cash:
        parts.append("This is modelled as a cash purchase, so returns are not sensitive to mortgage rates.")

    missing = [_INPUT_LABELS[path] for path in facts["data_quality"]["estimated_or_missing_inputs"] if path in _INPUT_LABELS and (analysis.provenance.get(path) != "unavailable" or path == "fixed.hoa_monthly")]
    missing += [c for c in analysis.quality_ltr.caveats if c not in missing]
    if ctx and ctx.is_demo:
        missing.insert(0, "This is synthetic demo data, not a real listing.")

    questions = [
        "What is the current assessed value, and how will property tax change after the sale?",
        "What do landlord insurance quotes look like for this address (including flood or wind coverage if applicable)?",
        "What is the age and condition of the roof, HVAC, water heater, plumbing and electrical systems?",
        "Do recent signed leases for comparable homes nearby support the estimated rent?",
    ]
    if a.fixed.hoa_monthly > 0 or analysis.provenance.get("fixed.hoa_monthly") == "unavailable":
        questions.append("Is there an HOA? What are the dues, special assessments and rental restrictions?")
    if ctx and ctx.price_reduction:
        questions.append("Why was the price reduced — inspection findings, a failed contract, or initial overpricing?")

    return AIExplanation(
        summary=summary,
        attractive_points=attractive,
        cash_flow=cash_flow,
        strategy_comparison=comparison,
        strengths=strengths or ["No clear financial strengths under the current assumptions."],
        risks=risks or ["No major financial risks were flagged by the rules, but all estimates still need verification."],
        sensitivity=" ".join(parts) or "Sensitivity figures are unavailable because rental income is not available.",
        missing_information=list(dict.fromkeys(missing)) or ["No critical gaps were detected in the data used."],
        due_diligence_questions=questions,
    )


# --------------------------------------------------------------------------- LLM engine

_SYSTEM = """You are an investment analyst explaining a rental property analysis to an individual investor.

You will receive a JSON facts sheet. It contains every figure you may use: listing facts, the user's assumptions, results calculated by a deterministic financial engine, stress tests and data-quality notes. Every property is evaluated as a long-term rental only.

Ground rules, which exist because investors will act on what you write:
- Use only numbers that appear in the facts sheet, quoted as given (you may round to whole dollars or one decimal place). Do not calculate new figures, combine figures into new ones, or estimate anything yourself. If a figure you want is not there, say it is not available.
- Discuss long-term renting only. Do not mention short-term or vacation rentals.
- Do not mention comparable sales, neighbourhood qualities, schools, or market trends: none are in the facts sheet.
- When is_demo_sample_data is true, say plainly that this is sample data rather than a real listing.
- Treat estimated or missing inputs (data_quality) as things the investor must verify, and say so.

Write plainly for a reader who knows basic real estate terms. Be specific and balanced: name the real risks as clearly as the strengths. Keep each list to the three to five points that matter most."""


async def explain(ctx: PropertyContext | None, analysis: PropertyAnalysis, model_name: str) -> AIExplanationResponse:
    facts = build_facts(ctx, analysis)
    is_demo = bool(ctx and ctx.is_demo)
    fallback = rule_based_explanation(ctx, analysis, facts)
    try:
        explanation = await generate_structured(
            system=_SYSTEM,
            user="<facts>\n" + json.dumps(facts, indent=1, default=str) + "\n</facts>\n\nExplain this analysis.",
            schema=AIExplanation,
            purpose="ai-explanation",
        )
    except LLMUnavailable as exc:
        note = None if str(exc) == "No LLM is configured" else f"{exc}; showing the rule-based summary instead."
        return AIExplanationResponse(engine="rules", explanation=fallback, note=note or "No LLM is configured (set ANTHROPIC_API_KEY); this summary is generated by deterministic rules.", is_demo=is_demo)

    unverified = ungrounded_numbers(explanation, facts)
    if unverified:
        return AIExplanationResponse(
            engine="rules",
            explanation=fallback,
            note="The AI response quoted figures that could not be traced to calculated values (" + ", ".join(unverified[:5]) + "), so it was discarded and the rule-based summary is shown.",
            is_demo=is_demo,
        )
    return AIExplanationResponse(engine="llm", model=model_name, explanation=explanation, is_demo=is_demo)
