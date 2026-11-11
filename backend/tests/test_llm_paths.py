"""LLM-backed paths with a stubbed Anthropic client: request shape, grounding and fallbacks."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas.analysis import AssumptionOverrides
from app.services import llm as llm_module
from app.services.ai_analyst import AIExplanation, explain
from app.services.analysis import analyze
from app.services.nl_search import parse_query


class FakeMessages:
    def __init__(self, respond):
        self.respond = respond
        self.calls: list[dict] = []

    async def parse(self, **kwargs):
        self.calls.append(kwargs)
        return self.respond(kwargs)


class FakeClient:
    def __init__(self, respond):
        self.messages = FakeMessages(respond)
        self.beta = SimpleNamespace(messages=self.messages)


@pytest.fixture
def analysis():
    overrides = AssumptionOverrides.model_validate({"acquisition": {"purchase_price": 250000}, "long_term": {"monthly_rent": 2300}})
    return analyze(None, overrides=overrides)


def install(monkeypatch, respond) -> FakeClient:
    client = FakeClient(respond)
    monkeypatch.setattr(llm_module, "_get_client", lambda: client)
    return client


def explanation(summary: str) -> AIExplanation:
    return AIExplanation(
        summary=summary, attractive_points=["Solid yield."], cash_flow="See summary.", strategy_comparison="Only long-term rental can be evaluated.",
        strengths=["Positive leverage."], risks=["Estimates need verification."], sensitivity="Not provided.", missing_information=["Insurance quote."], due_diligence_questions=["What is the roof age?"],
    )


async def test_grounded_llm_explanation_is_used_and_request_is_well_formed(app, monkeypatch, analysis):
    ltr = analysis.long_term
    text = f"The long-term scenario shows a {ltr.gross_yield_pct}% gross yield and ${ltr.monthly_cash_flow:,.0f} monthly cash flow at {analysis.assumptions.financing.interest_rate_pct}% interest."
    client = install(monkeypatch, lambda kwargs: SimpleNamespace(stop_reason="end_turn", parsed_output=explanation(text)))

    result = await explain(None, analysis, "claude-opus-5-5")
    assert result.engine == "llm" and result.grounded and result.explanation.summary == text

    call = client.messages.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["output_format"] is AIExplanation
    assert call["betas"] == ["server-side-fallback-2026-07-01"] and call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "medium"}
    assert "thinking" not in call and "temperature" not in call  # not accepted by current models
    assert "<facts>" in call["messages"][0]["content"] and str(float(ltr.noi_annual)) in call["messages"][0]["content"]
    assert "Use only numbers that appear in the facts sheet" in call["system"]


async def test_llm_response_with_invented_figures_is_discarded(app, monkeypatch, analysis):
    install(monkeypatch, lambda kwargs: SimpleNamespace(stop_reason="end_turn", parsed_output=explanation("Expect 14.5% appreciation and $9,999 of monthly profit.")))
    result = await explain(None, analysis, "claude-opus-5-5")
    assert result.engine == "rules"
    assert "could not be traced" in result.note and "14.5" in result.note
    assert "9,999" not in result.explanation.summary


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
async def test_refusal_or_truncation_falls_back_to_rules(app, monkeypatch, analysis, stop_reason):
    install(monkeypatch, lambda kwargs: SimpleNamespace(stop_reason=stop_reason, parsed_output=None))
    result = await explain(None, analysis, "claude-opus-5-5")
    assert result.engine == "rules" and "rule-based summary" in result.note


async def test_llm_search_parse_is_revalidated(app, monkeypatch):
    from app.services.nl_search import Unsupported, _Extraction

    install(
        monkeypatch,
        lambda kwargs: SimpleNamespace(
            stop_reason="end_turn",
            parsed_output=_Extraction(cities=["Macon, GA"], max_price=180000, min_cap_rate=7, strategy="ltr", sort="cap_rate", unsupported=[Unsupported(criterion="near good schools", reason="No school data.")]),
        ),
    )
    parsed = await parse_query("ltr deals in Macon GA under 180k, cap rate 7+, near good schools")
    assert parsed.engine == "llm" and parsed.valid
    assert parsed.filters == {"cities": ["Macon, GA"], "max_price": 180000.0, "min_cap_rate": 7.0}
    assert parsed.sort == "cap_rate" and parsed.unsupported[0].criterion == "near good schools"

    # A model answer that breaks the filter schema is reported as invalid, never executed.
    install(monkeypatch, lambda kwargs: SimpleNamespace(stop_reason="end_turn", parsed_output=_Extraction(zip_codes=["3026"], state="Georgia")))
    bad = await parse_query("homes in 3026")
    assert bad.valid is False and bad.warnings
