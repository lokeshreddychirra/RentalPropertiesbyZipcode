"""End-to-end API tests in demo mode (real PostgreSQL + Redis, synthetic provider data)."""

from __future__ import annotations

import asyncio

import pytest

API = "/api/v1"


async def run_search(client, filters: dict, **extra) -> dict:
    response = await client.post(f"{API}/searches/run", json={"filters": filters, **extra})
    assert response.status_code == 202, response.text
    job = response.json()
    for _ in range(200):
        if job["status"] in ("completed", "failed"):
            break
        await asyncio.sleep(0.05)
        job = (await client.get(f"{API}/searches/jobs/{job['id']}")).json()
    assert job["status"] == "completed", job
    return job


async def results(client, job_id: str, **params) -> dict:
    response = await client.get(f"{API}/searches/jobs/{job_id}/results", params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def test_status_labels_demo_mode(client):
    body = (await client.get(f"{API}/system/status")).json()
    assert body["data_mode"] == "demo"
    assert "not real listings" in body["demo_notice"]
    assert any(m["city"] == "Atlanta" for m in body["demo_markets"])
    assert all(not p["configured"] for p in body["providers"])


async def test_search_paginates_all_listings_and_ranks(client):
    job = await run_search(client, {"zip_codes": ["30269"]})
    # Demo provider pages are 25 listings; a ZIP has 30–44, so more than one page must be fetched.
    assert job["progress"]["pages_fetched"] >= 2
    assert job["listings_fetched"] == job["result_count"] >= 30
    assert job["partial"] is False

    data = await results(client, job["id"], page_size=200)
    assert data["total"] == job["result_count"]
    scores = [c["score"] for c in data["items"] if c["score"] is not None]
    assert scores == sorted(scores, reverse=True)
    card = data["items"][0]
    assert card["is_demo"] is True and card["listing_url"] is None
    assert {"long_term", "short_term", "badges", "confidence", "upfront_cash"} <= set(card)

    page2 = await results(client, job["id"], page=2, page_size=10)
    assert page2["page"] == 2 and len(page2["items"]) == 10
    assert page2["items"][0]["id"] == data["items"][10]["id"]


@pytest.mark.parametrize(
    "sort,key,descending",
    [("gross_yield", "gross_yield_pct", True), ("cap_rate", "cap_rate_pct", True), ("cash_on_cash", "cash_on_cash_pct", True), ("cash_flow", "monthly_cash_flow", True), ("upfront", "total_cash_invested", False), ("net_yield", "net_yield_pct", True)],
)
async def test_sorting_uses_calculated_metrics(client, sort, key, descending):
    job = await run_search(client, {"zip_codes": ["30310"], "strategy": "ltr"})
    data = await results(client, job["id"], sort=sort, page_size=200)
    values = [c["long_term"][key] for c in data["items"] if c["long_term"]["available"]]
    assert len(values) > 10
    assert values == sorted(values, reverse=descending)
    unavailable = [i for i, c in enumerate(data["items"]) if not c["long_term"]["available"]]
    assert all(i >= len(values) for i in unavailable)  # unranked properties always last


async def test_metric_and_listing_filters(client):
    filters = {"cities": ["Atlanta, GA"], "min_price": 150000, "max_price": 400000, "min_gross_yield": 8, "min_beds": 3, "strategy": "ltr"}
    job = await run_search(client, filters)
    data = await results(client, job["id"], page_size=200)
    assert data["total"] > 0
    for card in data["items"]:
        assert 150000 <= card["price"] <= 400000
        assert card["bedrooms"] >= 3
        assert card["long_term"]["gross_yield_pct"] >= 8
        assert card["city"] == "Atlanta"
    strict = await run_search(client, {**filters, "min_cash_flow": 300, "min_cap_rate": 6})
    strict_data = await results(client, strict["id"], page_size=200)
    assert 0 < strict_data["total"] < data["total"]
    assert all(c["long_term"]["monthly_cash_flow"] >= 300 and c["long_term"]["cap_rate_pct"] >= 6 for c in strict_data["items"])


async def test_identical_search_is_served_from_cache(client):
    first = await run_search(client, {"zip_codes": ["38116"]})
    again = (await client.post(f"{API}/searches/run", json={"filters": {"zip_codes": ["38116"]}})).json()
    assert again["id"] == first["id"] and again["cached"] is True
    fresh = (await client.post(f"{API}/searches/run", json={"filters": {"zip_codes": ["38116"]}, "refresh": True})).json()
    assert fresh["id"] != first["id"]


async def test_radius_and_polygon_and_map(client):
    job = await run_search(client, {"cities": ["Atlanta, GA"], "radius_miles": 12})
    points = (await client.get(f"{API}/searches/jobs/{job['id']}/map")).json()
    assert points["total"] == job["result_count"] > 100
    zips = {c["zip_code"] for c in (await results(client, job["id"], page_size=200))["items"]}
    assert "30032" in zips  # Decatur is inside the radius although it is another city

    p = points["points"][0]
    box = f"{p['longitude'] - 0.01},{p['latitude'] - 0.01},{p['longitude'] + 0.01},{p['latitude'] + 0.01}"
    inside = await results(client, job["id"], bbox=box, page_size=200)
    assert 0 < inside["total"] < points["total"]
    poly = f"{p['longitude'] - 0.01},{p['latitude'] - 0.01};{p['longitude'] + 0.01},{p['latitude'] - 0.01};{p['longitude']},{p['latitude'] + 0.02}"
    drawn = await results(client, job["id"], polygon=poly, page_size=200)
    assert 0 < drawn["total"] <= inside["total"] + 5


async def test_county_and_state_searches(client):
    county = await run_search(client, {"county": "Fayette", "state": "GA"})
    data = await results(client, county["id"], page_size=200)
    assert data["total"] > 0 and {c["county"] for c in data["items"]} == {"Fayette"}
    state = await run_search(client, {"state": "TN", "property_types": ["condo", "townhouse"]})
    assert any("State-wide" in w for w in state["warnings"])
    state_data = await results(client, state["id"], page_size=200)
    assert {c["state"] for c in state_data["items"]} == {"TN"}
    assert {c["property_type"] for c in state_data["items"]} <= {"condo", "townhouse"}


async def test_validation_errors_are_structured(client):
    response = await client.post(f"{API}/searches/run", json={"filters": {"min_price": 100}})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error" and "location" in str(error["details"]).lower()
    assert (await client.post(f"{API}/searches/run", json={"filters": {"zip_codes": ["3026"]}})).status_code == 422
    assert (await client.get(f"{API}/properties/search", params={"zip_codes": "abc"})).status_code == 422
    missing = await client.get(f"{API}/properties/00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"


async def test_synchronous_search_endpoint(client):
    response = await client.get(f"{API}/properties/search", params={"zip_codes": ["44105"], "sort": "cash_flow", "page_size": 5})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["job"]["status"] == "completed" and len(body["items"]) == 5


async def _first_property(client, zip_code="30318", **filters) -> dict:
    job = await run_search(client, {"zip_codes": [zip_code], **filters})
    return (await results(client, job["id"], page_size=200))["items"][0]


async def test_property_detail_and_estimates(client):
    card = await _first_property(client)
    pid = card["id"]
    detail = (await client.get(f"{API}/properties/{pid}")).json()
    assert detail["context"]["is_demo"] is True
    assert detail["price_history"] and detail["sources"][0]["provider"] == "Demo dataset"
    assert "Synthetic sample data" in detail["attribution"][0]

    rent = (await client.get(f"{API}/properties/{pid}/rent-estimate")).json()
    assert rent["available"] and rent["level"] == "property" and rent["rent_low"] <= rent["rent"] <= rent["rent_high"]
    assert len(rent["comparables"]) == rent["comp_count"] >= 2
    value = (await client.get(f"{API}/properties/{pid}/value-estimate")).json()
    assert value["available"] is False and value["can_request"] is True
    value = (await client.get(f"{API}/properties/{pid}/value-estimate", params={"fetch": True})).json()
    assert value["available"] and value["fetched_now"] and value["comparables"]
    st = (await client.get(f"{API}/properties/{pid}/str-estimate")).json()
    assert st["available"] and len(st["seasonality"]) == 12


async def test_calculate_recalculates_with_overrides_and_provenance(client):
    card = await _first_property(client)
    pid = card["id"]
    base = (await client.post(f"{API}/analysis/calculate", json={"property_id": pid})).json()
    assert base["provenance"]["acquisition.purchase_price"] == "verified"
    assert base["provenance"]["long_term.monthly_rent"] == "estimated"
    assert base["provenance"]["financing.down_payment_pct"] == "default"
    assert base["long_term"]["monthly_cash_flow"] == card["long_term"]["monthly_cash_flow"]

    body = {
        "property_id": pid,
        "overrides": {"long_term": {"monthly_rent": 3100}, "financing": {"down_payment_pct": 100}},
        "include": ["forecast", "scenarios", "sensitivity", "financing"],
        "custom_financing": [{"name": "Investor DSCR loan", "down_payment_pct": 35, "interest_rate_pct": 7.9, "loan_term_years": 30}],
    }
    changed = (await client.post(f"{API}/analysis/calculate", json=body)).json()
    assert changed["provenance"]["long_term.monthly_rent"] == "user"
    assert changed["long_term"]["gross_annual_income"] == 37200
    assert changed["long_term"]["dscr"] is None and changed["loan"]["is_cash"] is True
    assert changed["quality_ltr"]["factors"][1]["provenance"] == "user"
    assert len(changed["forecast_ltr"]["years"]) == 30
    assert [h["years"] for h in changed["forecast_ltr"]["horizons"]] == [1, 5, 10, 15, 30]
    assert [s["name"] for s in changed["scenarios_str"]] == ["conservative", "base", "optimistic"]
    assert {t["variable"] for t in changed["sensitivity_ltr"]["tables"]} == {"purchase_price", "rent", "occupancy"}  # no rate table for cash
    assert any(f["label"] == "Investor DSCR loan" for f in changed["financing"])

    invalid = await client.post(f"{API}/analysis/calculate", json={"property_id": pid, "overrides": {"financing": {"down_payment_pct": 140}}})
    assert invalid.status_code == 422
    adhoc = (await client.post(f"{API}/analysis/calculate", json={"overrides": {"acquisition": {"purchase_price": 250000}, "long_term": {"monthly_rent": 2200}}})).json()
    assert adhoc["long_term"]["available"] and adhoc["short_term"]["available"] is False
    assert adhoc["recommendation"]["strategy"] == "ltr"
    assert (await client.post(f"{API}/analysis/calculate", json={})).status_code == 422


async def test_str_never_recommended_where_prohibited(client):
    job = await run_search(client, {"zip_codes": ["44120"]})  # demo ZIP flagged "prohibited"
    data = await results(client, job["id"], sort="str_return", page_size=200)
    assert data["items"]
    for card in data["items"]:
        assert card["legality_status"] == "prohibited"
        assert card["primary_strategy"] != "str"
        assert card["short_term"]["score"] in (0, None)
        assert any(b["key"] == "str_restrictions" for b in card["badges"])


async def test_unknown_legality_recommendation_is_conditional(client):
    job = await run_search(client, {"zip_codes": ["32413", "32808"]})
    data = await results(client, job["id"], page_size=200)
    unknown_str = [c for c in data["items"] if c["legality_status"] == "unknown" and c["primary_strategy"] == "str"]
    assert unknown_str and all(c["recommendation_conditional"] for c in unknown_str)
    permitted_str = [c for c in data["items"] if c["legality_status"] == "permitted" and c["primary_strategy"] == "str"]
    assert permitted_str and not any(c["recommendation_conditional"] for c in permitted_str)


async def test_compare_highlights_best_per_metric(client):
    job = await run_search(client, {"zip_codes": ["30310"]})
    ids = [c["id"] for c in (await results(client, job["id"], page_size=5))["items"]]
    body = (await client.post(f"{API}/analysis/compare", json={"property_ids": ids[:4]})).json()
    assert len(body["items"]) == 4
    metrics = {m["key"]: m for m in body["metrics"]}
    price = metrics["price"]
    assert price["better"] == "lower" and price["values"][price["best_index"]] == min(price["values"])
    cash = metrics["ltr_cash_flow"]
    numeric = [v for v in cash["values"] if v is not None]
    if cash["best_index"] is not None:
        assert cash["values"][cash["best_index"]] == max(numeric)
    assert metrics["ltr_10y_profit"]["values"][0] is not None
    too_many = await client.post(f"{API}/analysis/compare", json={"property_ids": ids + ids[:1]})
    assert too_many.status_code == 422


async def test_ai_explanation_falls_back_to_grounded_rules(client):
    card = await _first_property(client, "34747")
    body = (await client.post(f"{API}/analysis/ai-explanation", json={"property_id": card["id"]})).json()
    assert body["engine"] == "rules" and body["grounded"] and body["is_demo"]
    text = body["explanation"]["summary"]
    assert "cap rate" in text and "%" in text
    assert any("demo data" in item for item in body["explanation"]["missing_information"])
    assert body["explanation"]["due_diligence_questions"]


async def test_natural_language_parse(client):
    body = (await client.post(f"{API}/searches/parse", json={"query": "Find houses under $300,000 near Atlanta with at least $500 per month cash flow in good school districts"})).json()
    assert body["engine"] == "rules" and body["valid"]
    assert body["filters"]["cities"] == ["Atlanta, GA"] and body["filters"]["max_price"] == 300000
    assert body["filters"]["min_cash_flow"] == 500 and body["filters"]["property_types"] == ["single_family"]
    assert body["unsupported"][0]["criterion"] == "school quality"
    job = await run_search(client, body["filters"])
    assert job["status"] == "completed"


async def test_market_summary(client):
    body = (await client.get(f"{API}/market/summary", params={"zip_codes": ["30310", "32413"]})).json()
    assert body["is_demo"] and len(body["markets"]) == 2
    market = body["markets"][0]
    assert market["gross_yield_pct"] > 0 and len(market["stats"]["history"]) == 12 and market["yield_by_bedrooms"]
    assert (await client.get(f"{API}/market/summary")).status_code == 422


async def test_auth_favorites_saved_searches_and_admin(client):
    assert (await client.get(f"{API}/favorites")).status_code == 401
    card = await _first_property(client, "46201")

    weak = await client.post(f"{API}/auth/register", json={"email": "a@example.com", "password": "short"})
    assert weak.status_code == 422
    admin = await client.post(f"{API}/auth/register", json={"email": "Admin@Example.com", "password": "correct-horse-battery", "name": "Ada"})
    assert admin.status_code == 201 and admin.json()["user"]["role"] == "admin"  # first account administers
    assert "httponly" in admin.headers["set-cookie"].lower()
    assert (await client.post(f"{API}/auth/register", json={"email": "admin@example.com", "password": "correct-horse-battery"})).status_code == 409
    assert (await client.get(f"{API}/auth/me")).json()["user"]["email"] == "admin@example.com"

    fav = await client.post(f"{API}/favorites", json={"property_id": card["id"], "notes": "Check roof"})
    assert fav.status_code == 201
    assert (await client.post(f"{API}/favorites", json={"property_id": card["id"], "notes": "Updated"})).status_code == 201  # idempotent
    favorites = (await client.get(f"{API}/favorites")).json()
    assert len(favorites) == 1 and favorites[0]["notes"] == "Updated" and favorites[0]["card"]["id"] == card["id"]
    assert (await client.get(f"{API}/properties/{card['id']}")).json()["is_favorite"] is True

    watchlist = (await client.post(f"{API}/watchlists", json={"name": "Midwest"})).json()
    moved = await client.patch(f"{API}/favorites/{card['id']}", json={"watchlist_id": watchlist["id"]})
    assert moved.json()["watchlist_id"] == watchlist["id"]
    assert (await client.get(f"{API}/watchlists")).json()[0]["property_count"] == 1

    saved = await client.post(f"{API}/searches/save", json={"name": "Indy", "filters": {"zip_codes": ["46201"]}, "alerts_enabled": True, "cash_flow_threshold": 100})
    assert saved.status_code == 201
    assert len((await client.get(f"{API}/searches/saved")).json()) == 1

    analysis = await client.post(f"{API}/analysis/saved", json={"property_id": card["id"], "name": "First pass", "overrides": {"financing": {"down_payment_pct": 30}}})
    assert analysis.status_code == 201 and analysis.json()["overrides"]["financing"]["down_payment_pct"] == 30
    assert len((await client.get(f"{API}/analysis/saved")).json()) == 1

    prefs = await client.put(f"{API}/auth/preferences", json={"default_assumptions": {"financing": {"interest_rate_pct": 6.5}}, "score_weights": {"cash_flow": 40}})
    assert prefs.status_code == 200
    assert (await client.get(f"{API}/auth/preferences")).json()["default_assumptions"]["financing"]["interest_rate_pct"] == 6.5

    budget = await client.put(f"{API}/system/budgets/rentcast", json={"monthly_request_limit": 250})
    assert budget.status_code == 200 and budget.json()["monthly_request_limit"] == 250
    regulation = await client.put(
        f"{API}/system/str-regulations",
        json={"jurisdiction_type": "city", "jurisdiction_key": "Atlanta, GA", "status": "restricted", "source_url": "https://example.gov/str", "verified_at": "2026-01-15", "summary": "Permit required"},
    )
    assert regulation.status_code == 200 and regulation.json()["jurisdiction_key"] == "atlanta,ga"
    assert (await client.put(f"{API}/system/str-regulations", json={"jurisdiction_type": "zip", "jurisdiction_key": "30303", "status": "permitted", "verified_at": "2026-01-15"})).status_code == 422  # source required
    usage = (await client.get(f"{API}/system/usage")).json()
    assert {p["key"] for p in usage["providers"]} >= {"rentcast", "airdna", "mapbox", "anthropic"}

    await client.post(f"{API}/auth/logout")
    client.cookies.clear()
    assert (await client.get(f"{API}/favorites")).status_code == 401
    other = await client.post(f"{API}/auth/register", json={"email": "user@example.com", "password": "another-long-password"})
    assert other.json()["user"]["role"] == "user"
    assert (await client.put(f"{API}/system/budgets/rentcast", json={"monthly_request_limit": 9})).status_code == 403
    assert (await client.get(f"{API}/favorites")).json() == []  # users only see their own data
    assert (await client.delete(f"{API}/searches/saved/{saved.json()['id']}")).status_code == 404
    bad_login = await client.post(f"{API}/auth/login", json={"email": "user@example.com", "password": "wrong-password-here"})
    assert bad_login.status_code == 401
