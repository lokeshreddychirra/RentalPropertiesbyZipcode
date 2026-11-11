"""Provider adapters, dedupe, budgets / partial-result disclosure, alerts and AI grounding."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal as D
from types import SimpleNamespace

import httpx
import pytest

from app.core.config import Settings
from app.providers.airdna import parse_estimate
from app.providers.base import BudgetExceeded, ListingQuery, ListingRecord, ProviderAuthError, SubjectProperty
from app.providers.registry import ProviderSet
from app.providers.rentcast import RentCastProvider, parse_listing
from app.providers.usage import get_usage_tracker
from app.schemas.search import JobProgress, SearchFilters, SearchRunRequest
from app.services.ai_analyst import AIExplanation, ungrounded_numbers
from app.services.alerts import detect_events
from app.services.dedupe import dedupe_key, merge_listings
from app.services.search import execute_search

API = "/api/v1"


def rentcast_listing(n: int, **over) -> dict:
    base = {
        "id": f"{n}-Main-St,-Dalton,-GA-30720",
        "formattedAddress": f"{n} Main St, Dalton, GA 30720",
        "addressLine1": f"{n} Main St",
        "city": "Dalton",
        "state": "GA",
        "zipCode": "30720",
        "county": "Whitfield",
        "latitude": 34.77 + n * 1e-4,
        "longitude": -84.97,
        "propertyType": "Single Family",
        "bedrooms": 3,
        "bathrooms": 2,
        "squareFootage": 1500,
        "yearBuilt": 1995,
        "hoa": {"fee": 25},
        "status": "Active",
        "price": 200000 + n * 100,
        "listedDate": "2026-05-01T00:00:00.000Z",
        "lastSeenDate": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "daysOnMarket": 20,
        "mlsName": "TestMLS",
        "mlsNumber": str(n),
        "listingAgent": {"name": "A. Agent"},
        "history": {"2026-05-01": {"event": "Sale Listing", "price": 215000, "listedDate": "2026-05-01T00:00:00.000Z"}, "2026-05-20": {"event": "Sale Listing", "price": 200000 + n * 100}},
    }
    base.update(over)
    return base


def test_rentcast_listing_parsing_and_price_history():
    record = parse_listing(rentcast_listing(1))
    assert record.status == "active" and record.property_type == "single_family"
    assert record.price == D("200100") and record.hoa_fee_monthly == D("25") and record.agent_name == "A. Agent"
    assert [e.event_type for e in record.price_history] == ["listed", "price_change"]
    assert record.image_urls == [] and record.listing_url is None  # RentCast does not supply these
    assert parse_listing({"formattedAddress": "x"}) is None
    sparse = parse_listing({"id": "a", "formattedAddress": "1 A St, B, GA 30000", "status": "Inactive", "price": "abc"})
    assert sparse.status == "inactive" and sparse.price is None


def make_rentcast(handler, **settings) -> RentCastProvider:
    cfg = Settings(rentcast_api_key="test-key", rentcast_page_size=500, rentcast_requests_per_second=1000, **settings)
    return RentCastProvider(cfg, transport=httpx.MockTransport(handler))


async def test_rentcast_paginates_until_short_page(app):
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Api-Key"] == "test-key"
        params = dict(request.url.params)
        calls.append(params)
        offset, limit = int(params["offset"]), int(params["limit"])
        total = 1200
        return httpx.Response(200, json=[rentcast_listing(i) for i in range(offset, min(offset + limit, total))])

    provider = make_rentcast(handler)
    providers = ProviderSet(mode="live", listing_providers=[provider])

    async def progress(_: JobProgress) -> None:
        return None

    outcome = await execute_search(SearchRunRequest(filters=SearchFilters(zip_codes=["30720"]), refresh=True), progress, providers)
    assert [c["offset"] for c in calls] == ["0", "500", "1000"]
    assert calls[0]["zipCode"] == "30720" and calls[0]["status"] == "Active"
    assert outcome.listings_fetched == 1200 and len(outcome.cards) == 1200
    assert outcome.partial_reasons == []
    # No rent provider configured here: returns are unavailable, never invented.
    assert all(not card.long_term.available and card.score is None for card in outcome.cards)
    await provider.aclose()


async def test_budget_exhaustion_is_disclosed_as_partial(app, client):
    await client.post(f"{API}/auth/register", json={"email": f"{uuid.uuid4().hex}@example.com", "password": "correct-horse-battery"})
    tracker = get_usage_tracker()
    used, _, _ = await tracker.month_to_date("rentcast")

    def handler(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params["offset"])
        return httpx.Response(200, json=[rentcast_listing(10_000 + i) for i in range(offset, offset + 500)])

    provider = make_rentcast(handler)
    from app.core.db import session_scope
    from app.models.tables import Provider

    async with session_scope() as session:
        row = await session.get(Provider, "rentcast")
        original = row.monthly_request_limit
        row.monthly_request_limit = used + 2  # allow exactly two more pages
    tracker.invalidate("rentcast")
    try:
        async def progress(_: JobProgress) -> None:
            return None

        outcome = await execute_search(SearchRunRequest(filters=SearchFilters(zip_codes=["30721"]), refresh=True), progress, ProviderSet(mode="live", listing_providers=[provider]))
        assert outcome.listings_fetched == 1000
        assert any("budget" in reason.lower() and "incomplete" in reason for reason in outcome.partial_reasons)
        with pytest.raises(BudgetExceeded):
            await provider.search_listings(ListingQuery(zip_code="30721"), offset=0, limit=10)
    finally:
        async with session_scope() as session:
            (await session.get(Provider, "rentcast")).monthly_request_limit = original
        tracker.invalidate("rentcast")
        await provider.aclose()


async def test_rentcast_retries_rate_limits_and_reports_auth_errors(app):
    attempts = {"n": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"rent": 1850, "rentRangeLow": 1700, "rentRangeHigh": 2000, "comparables": [{"formattedAddress": "2 B St", "price": 1800, "distance": 0.4, "correlation": 0.97}]})

    provider = make_rentcast(flaky)
    estimate = await provider.rent_estimate(SubjectProperty(formatted_address="1 A St, Dalton, GA 30720", bedrooms=D("3")))
    assert attempts["n"] == 3 and estimate.rent == D("1850") and len(estimate.comparables) == 1
    await provider.aclose()

    denied = make_rentcast(lambda request: httpx.Response(403, json={"error": "billing/subscription-inactive", "message": "The provided API key is not associated with an active API subscription."}))
    with pytest.raises(ProviderAuthError) as refused:
        await denied.market_stats("30720")
    assert "active API subscription" in refused.value.message  # the provider's own reason reaches the user
    await denied.aclose()

    missing = make_rentcast(lambda request: httpx.Response(404, json={}))
    assert await missing.rent_estimate(SubjectProperty(formatted_address="nowhere")) is None  # unavailable, not invented
    await missing.aclose()


def test_airdna_parser_is_strict_about_missing_data():
    good = parse_estimate({"payload": {"stats": {"future": {"summary": {"adr": 212.5, "occupancy": 0.61, "revenue": 47300}}}, "comps": [{}, {}]}})
    assert good.adr == D("212.50") and good.occupancy_pct == D("61.00") and good.adr_includes_cleaning_fee and good.comp_count == 2
    assert parse_estimate({"payload": {"stats": {"future": {"summary": {"adr": 200}}}}}) is None
    assert parse_estimate({"payload": {"summary": {"adr": 200, "occupancy": 140}}}) is None
    assert parse_estimate("nonsense") is None


def _record(provider: str, line1: str, **over) -> ListingRecord:
    data = dict(provider=provider, provider_listing_id=f"{provider}-{line1}", status="active", formatted_address=f"{line1}, Atlanta, GA 30310", address_line1=line1, city="Atlanta", state="GA", zip_code="30310", price=D("250000"))
    data.update(over)
    return ListingRecord(**data)


def test_dedupe_merges_same_home_across_providers():
    a = _record("rentcast", "123 North Main Street", last_seen_at=datetime(2026, 6, 1, tzinfo=UTC), bedrooms=D("3"))
    b = _record("mls", "123 N. Main St", last_seen_at=datetime(2026, 6, 3, tzinfo=UTC), price=D("245000"), image_urls=["https://img/1.jpg"], square_feet=1400)
    c = _record("mls", "125 N Main St")
    d = _record("mls", "123 N Main St Apt 4B")
    assert dedupe_key(a) == dedupe_key(b) != dedupe_key(c)
    assert dedupe_key(d) != dedupe_key(a) and dedupe_key(d) == dedupe_key(_record("x", "123 N Main St", address_line2="Unit 4b"))
    merged = {m.key: m for m in merge_listings([a, b, c, d])}
    assert len(merged) == 3
    home = merged[dedupe_key(a)]
    assert home.primary.provider == "mls" and home.primary.price == D("245000")  # freshest record leads
    assert home.primary.bedrooms == D("3") and home.primary.square_feet == 1400  # gaps filled from the other source
    assert {s.provider for s in home.sources} == {"rentcast", "mls"} and home.image_urls == ["https://img/1.jpg"]


def _card(pid: str, price: float, cash_flow: float, gross_yield: float):
    summary = SimpleNamespace(available=True, monthly_cash_flow=D(str(cash_flow)), gross_yield_pct=D(str(gross_yield)))
    return SimpleNamespace(id=uuid.UUID(pid), price=D(str(price)), address_line1="1 A St", formatted_address="1 A St, B, GA", primary_strategy="ltr", long_term=summary, short_term=summary)


def test_alert_events_are_deduplicated_and_baselined():
    p1, p2 = "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
    search = SimpleNamespace(id=uuid.uuid4(), name="S", known_listings={}, last_checked_at=None, notify_new_listings=True, notify_price_reductions=True, cash_flow_threshold=D("300"), gross_yield_threshold=None)
    events, known = detect_events(search, [_card(p1, 200000, 350, 9)], "ltr")
    assert [e["type"] for e in events] == ["cash_flow_threshold"]  # first run is a baseline: no "new listing"
    search.known_listings, search.last_checked_at = known, datetime.now(UTC)

    events2, known2 = detect_events(search, [_card(p1, 190000, 350, 9), _card(p2, 150000, 100, 7)], "ltr")
    kinds = sorted(e["type"] for e in events2)
    assert kinds == ["cash_flow_threshold", "new_listing", "price_reduction"]
    # Same state again → identical dedupe keys, so the unique constraint drops them.
    search.known_listings = known
    assert {e["dedupe_key"] for e in detect_events(search, [_card(p1, 190000, 350, 9), _card(p2, 150000, 100, 7)], "ltr")[0]} == {e["dedupe_key"] for e in events2}
    assert next(e for e in events if e["type"] == "cash_flow_threshold")["dedupe_key"] == next(e for e in events2 if e["type"] == "cash_flow_threshold")["dedupe_key"]
    search.known_listings = known2
    assert [e["type"] for e in detect_events(search, [_card(p1, 190000, 350, 9), _card(p2, 150000, 100, 7)], "ltr")[0]] == ["cash_flow_threshold"]


def test_ai_grounding_rejects_invented_numbers():
    facts = {"long_term_rental": {"gross_yield_pct": 9.2, "monthly_cash_flow": 412.37, "total_cash_invested": 68450.0}, "assumptions": {"interest_rate_pct": 7.0, "loan_term_years": 30}}

    def explanation(summary: str) -> AIExplanation:
        return AIExplanation(summary=summary, attractive_points=[], cash_flow="", strategy_comparison="", strengths=[], risks=[], sensitivity="", missing_information=[], due_diligence_questions=["Has the roof been replaced in the last 12 years?"])

    assert ungrounded_numbers(explanation("Gross yield is 9.2% with $412 monthly cash flow on $68,450 invested at 7% over 30 years (about $68k)."), facts) == []
    bad = ungrounded_numbers(explanation("Gross yield is 11.5% and the home should appreciate 25% in 3 years."), facts)
    assert bad == ["11.5", "25"]


def test_land_listings_are_excluded_unless_requested():
    from app.services.search import ResolvedSearch, passes_listing_filters

    land = _record("rentcast", "9 Empty Lot Rd", property_type="land")
    house = _record("rentcast", "10 Home St", property_type="single_family")
    resolved = ResolvedSearch(queries=[])
    default = SearchFilters(zip_codes=["30310"])
    assert passes_listing_filters(house, default, resolved) and not passes_listing_filters(land, default, resolved)
    assert passes_listing_filters(land, SearchFilters(zip_codes=["30310"], property_types=["land"]), resolved)


def test_zip_level_screening_rent_is_conservative_and_needs_enough_listings():
    """Figures observed for a real ZIP: a 2-bed median of $3,300 from 7 listings vs ~$2,430 property-level."""
    from datetime import UTC, datetime

    from app.providers.base import BedroomStat, MarketStats

    stats = MarketStats(
        provider="rentcast", zip_code="30269", rental_listings=101, median_rent_per_sqft=D("1.6"), fetched_at=datetime.now(UTC),
        rent_by_bedrooms=[BedroomStat(bedrooms=2, median=D("3300"), count=7), BedroomStat(bedrooms=3, median=D("2400"), count=49), BedroomStat(bedrooms=6, median=D("4500"), count=1)],
    )
    assert stats.screening_rent(D("2"), 1370)[0] == D("2192")  # size-based estimate wins over the thin, high bedroom median
    assert stats.screening_rent(D("3"), 1660)[0] == D("2400")  # bedroom median is the lower of the two
    assert stats.screening_rent(D("6"), None) is None  # one listing is not a reliable statistic
    assert stats.screening_rent(D("7"), 4000)[0] == D("3300")  # no reliable bucket: size-based (6,400) capped at the highest reliable median
    assert stats.screening_rent(D("7"), 1500)[0] == D("2400")  # … and used as-is when it is below that cap
    assert stats.screening_rent(None, None) is None
    thin = stats.model_copy(update={"rental_listings": 12})
    assert thin.screening_rent(D("6"), 3900) is None  # too few listings for either statistic


async def test_area_rents_come_from_rental_listings_and_filters_reuse_the_cache(app, monkeypatch):
    """One rental-listings request replaces per-ZIP market calls; filter changes cost nothing."""
    import random

    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "rent_avm_top_n", 0)
    monkeypatch.setattr(get_settings(), "market_stats_fallback_max", 1)
    base = random.randint(90000, 98000)
    z_main, z_thin_a, z_thin_b = str(base), str(base + 1), str(base + 2)
    calls: dict[str, int] = {}

    def home(n: int, zip_code: str, **over) -> dict:
        return rentcast_listing(n, id=f"{n}-{zip_code}", formattedAddress=f"{n} Main St, Dalton, GA {zip_code}", zipCode=zip_code, **over)

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/v1")
        calls[path] = calls.get(path, 0) + 1
        if path == "/listings/sale":
            homes = [home(i, z_main) for i in range(6)] + [home(100 + i, z_thin_a) for i in range(2)] + [home(200 + i, z_thin_b) for i in range(3)]
            return httpx.Response(200, json=homes)
        if path == "/listings/rental/long-term":
            rentals = [home(500 + i, z_main, price=1700 + 20 * i, bedrooms=3) for i in range(8)]
            return httpx.Response(200, json=rentals)
        if path == "/markets":
            return httpx.Response(200, json={"rentalData": {"medianRent": 1500, "totalListings": 40, "medianRentPerSquareFoot": 1.0, "dataByBedrooms": [{"bedrooms": 3, "medianRent": 1500, "totalListings": 12}]}})
        return httpx.Response(404, json={})

    provider = make_rentcast(handler)
    providers = ProviderSet(mode="live", listing_providers=[provider], market=provider, rent=provider)

    async def progress(_: JobProgress) -> None:
        return None

    outcome = await execute_search(SearchRunRequest(filters=SearchFilters(cities=["Dalton, GA"])), progress, providers)
    assert calls == {"/listings/sale": 1, "/listings/rental/long-term": 1, "/markets": 1}  # no per-ZIP calls, no AVMs
    by_zip: dict[str, list] = {}
    for card in outcome.cards:
        by_zip.setdefault(card.zip_code, []).append(card)
    assert all(c.rent_source == "market_zip" and c.long_term.monthly_income == 1770 for c in by_zip[z_main])  # median of 8 rentals
    assert all(c.long_term.monthly_income == 1500 for c in by_zip[z_thin_b])  # biggest thin ZIP got the one fallback call
    assert all(not c.long_term.available for c in by_zip[z_thin_a])
    assert any("too few rental listings" in w and z_thin_a in w for w in outcome.warnings)

    # Changing locally applied filters reuses cached pages and stored rents: zero new requests.
    before = dict(calls)
    await execute_search(SearchRunRequest(filters=SearchFilters(cities=["Dalton, GA"], max_price=200300, min_beds=3, property_types=["single_family"])), progress, providers)
    assert calls == before
    await provider.aclose()


def test_rental_listing_aggregation():
    from app.services.search import stats_from_rentals

    now = datetime.now(UTC)
    rows = [parse_listing(rentcast_listing(i, price=1000 + 100 * i, bedrooms=2 + i % 2, squareFootage=1000)) for i in range(6)]
    rows.append(parse_listing(rentcast_listing(0, price=99)))  # same address, implausible rent: ignored
    stats = stats_from_rentals([r for r in rows if r], "rentcast", now)["30720"]
    assert stats.source == "rental_listings" and stats.rental_listings == 6
    assert stats.median_rent == D("1250.00")
    assert {b.bedrooms: b.count for b in stats.rent_by_bedrooms} == {2: 3, 3: 3}
    assert not stats.has_reliable_rent()  # 6 listings: below both sample thresholds
