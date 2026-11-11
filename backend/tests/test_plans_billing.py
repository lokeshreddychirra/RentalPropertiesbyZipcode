"""Plans, quotas, administrator user management and Stripe billing."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import uuid

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from app.core.config import get_settings
from app.services import billing, plans

API = "/api/v1"


@pytest.fixture(autouse=True)
async def _reset_rate_limits(app):
    from app.core.redis import get_redis

    redis = get_redis()
    keys = [key async for key in redis.scan_iter("ratelimit:*")]
    if keys:
        await redis.delete(*keys)


@pytest.fixture
def live_quotas(monkeypatch):
    """Quotas only apply in live mode; the suite runs on demo data, so switch them on."""
    monkeypatch.setattr(plans, "quotas_apply", lambda: True)


async def _new_user(app, password: str = "correct-horse-battery") -> tuple[AsyncClient, str]:
    email = f"{uuid.uuid4().hex[:12]}@example.com"
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    response = await client.post(f"{API}/auth/register", json={"email": email, "password": password})
    assert response.status_code == 201 and response.json()["user"]["plan"] == "free"
    return client, email


async def _search(client: AsyncClient, *zips: str) -> httpx.Response:
    return await client.post(f"{API}/searches/run", json={"filters": {"zip_codes": list(zips)}})


async def test_free_plan_allows_one_zip_and_paid_plans_raise_the_limit(app, client, live_quotas):
    user, email = await _new_user(app)
    try:
        assert (await _search(user, "30269")).status_code == 202
        assert (await _search(user, "30269")).status_code == 202  # same ZIP again: free
        blocked = await _search(user, "38116")
        assert blocked.status_code == 402
        error = blocked.json()["error"]
        assert error["code"] == "plan_limit" and error["details"] == {"plan": "free", "kind": "ZIP code searches", "used": 1, "limit": 1}
        two = await _search(user, "38116", "38118")
        assert two.status_code == 422 and two.json()["error"]["code"] == "one_zip"

        account = (await user.get(f"{API}/account")).json()
        assert account["zip_searches_used"] == 1 and account["zip_searches_limit"] == 1 and account["searched_zips"] == ["30269"]
        assert account["monthly"] is False  # the free allowance is lifetime

        # The administrator upgrades the user by hand (no online billing configured).
        listing = (await client.get(f"{API}/admin/users", params={"q": email})).json()
        target = listing["users"][0]
        assert target["email"] == email and target["login_count"] == 1 and target["last_login_at"] and target["searched_zips"] == ["30269"]
        assert "password" not in json.dumps(target).lower()
        summary = {row["plan"]: row for row in listing["plan_summary"]}
        assert summary["free"]["users"] >= 1 and summary["free"]["zip_searches"] >= 1 and summary["pro"]["revenue_usd"] == summary["pro"]["users"] * 19
        assert listing["zip_searches_this_month"] >= 1 and listing["new_users_this_month"] >= 1
        updated = (await client.patch(f"{API}/admin/users/{target['id']}", json={"plan": "pro"})).json()
        assert updated["plan"] == "pro" and updated["plan_status"] == "manual"

        assert (await _search(user, "38116")).status_code == 202  # Pro: monthly allowance, separate period
        account = (await user.get(f"{API}/account")).json()
        assert account["plan"] == "pro" and account["monthly"] and account["zip_searches_limit"] == get_settings().plan_pro_zip_searches
        assert (await _search(user, "38116", "38118")).status_code == 422  # every plan searches one ZIP at a time

        await client.patch(f"{API}/admin/users/{target['id']}", json={"plan": "premium"})
        assert (await _search(user, "38116", "38118")).status_code == 422  # Premium too
        assert (await _search(user, "38118")).status_code == 202
    finally:
        await user.aclose()


async def test_property_reports_are_metered_and_cached_ones_are_free(app, client, live_quotas, monkeypatch):
    monkeypatch.setattr(get_settings(), "plan_free_property_reports", 2)
    job = (await client.post(f"{API}/searches/run", json={"filters": {"zip_codes": ["44105"]}})).json()
    for _ in range(200):
        if job["status"] in ("completed", "failed"):
            break
        await asyncio.sleep(0.05)
        job = (await client.get(f"{API}/searches/jobs/{job['id']}")).json()
    items = (await client.get(f"{API}/searches/jobs/{job['id']}/results", params={"page_size": 10})).json()["items"]
    ids = [item["id"] for item in items]
    # Demo searches pre-compute property estimates; clear them so these properties need a new "purchase".
    from sqlalchemy import delete

    from app.core.db import session_scope
    from app.models.tables import RentEstimate, ValueEstimate

    async with session_scope() as session:
        await session.execute(delete(RentEstimate).where(RentEstimate.property_id.in_([uuid.UUID(i) for i in ids[:3]]), RentEstimate.level == "property"))
        await session.execute(delete(ValueEstimate).where(ValueEstimate.property_id.in_([uuid.UUID(i) for i in ids[:3]])))
    user, _ = await _new_user(app)
    anon = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        guest = (await anon.get(f"{API}/properties/{ids[0]}/rent-estimate", params={"fetch": True})).json()
        assert guest["level"] != "property" and "free account" in guest["reason"]
        # Demo rent estimates are generated on request, so each first fetch is a "report".
        for pid in ids[:2]:
            assert (await user.get(f"{API}/properties/{pid}/rent-estimate", params={"fetch": True})).json()["level"] == "property"
        third = (await user.get(f"{API}/properties/{ids[2]}/rent-estimate", params={"fetch": True})).json()
        assert third["level"] != "property" and "2 of 2 property reports" in third["reason"]
        # Already unlocked properties stay available.
        assert (await user.get(f"{API}/properties/{ids[0]}/value-estimate", params={"fetch": True})).json()["available"]
        assert (await user.get(f"{API}/account")).json()["property_reports_used"] == 2
    finally:
        await user.aclose()
        await anon.aclose()


async def test_admin_endpoints_are_protected(app, client):
    user, _ = await _new_user(app)
    try:
        assert (await user.get(f"{API}/admin/users")).status_code == 403
        me = (await client.get(f"{API}/admin/users", params={"q": "searcher@"})).json()["users"][0]
        assert (await client.patch(f"{API}/admin/users/{me['id']}", json={"role": "user"})).status_code == 409  # no self-lockout
        plans_out = (await user.get(f"{API}/account/plans")).json()
        assert [p["key"] for p in plans_out["plans"]] == ["free", "pro", "premium"] and plans_out["billing_enabled"] is False
        assert (await user.post(f"{API}/billing/checkout", json={"plan": "pro"})).status_code == 503  # payments not configured
    finally:
        await user.aclose()


def _signed(payload: dict, secret: str, timestamp: int | None = None) -> tuple[bytes, str]:
    body = json.dumps(payload).encode()
    ts = timestamp or int(time.time())
    signature = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return body, f"t={ts},v1={signature}"


async def test_stripe_checkout_and_webhooks_drive_the_plan(app, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "stripe_secret_key", SecretStr("sk_test_x"))
    monkeypatch.setattr(settings, "stripe_webhook_secret", SecretStr("whsec_x"))
    monkeypatch.setattr(settings, "stripe_price_pro", "price_pro")
    monkeypatch.setattr(settings, "stripe_price_premium", "price_premium")
    calls: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        form = dict(httpx.QueryParams(request.content.decode()))
        calls.append((request.url.path, form))
        if request.url.path.endswith("/customers"):
            return httpx.Response(200, json={"id": "cus_123"})
        if request.url.path.endswith("/checkout/sessions"):
            return httpx.Response(200, json={"url": "https://checkout.stripe.test/session"})
        return httpx.Response(404, json={"error": {"message": "nope"}})

    billing.set_transport(httpx.MockTransport(handler))
    user, email = await _new_user(app)
    try:
        url = (await user.post(f"{API}/billing/checkout", json={"plan": "premium"})).json()["url"]
        assert url == "https://checkout.stripe.test/session"
        session_form = calls[-1][1]
        assert session_form["line_items[0][price]"] == "price_premium" and session_form["customer"] == "cus_123" and session_form["mode"] == "subscription"
        user_id = (await user.get(f"{API}/auth/me")).json()["user"]["id"]

        bad_body, _ = _signed({"type": "x"}, "whsec_x")
        assert (await user.post(f"{API}/billing/webhook", content=bad_body, headers={"Stripe-Signature": "t=1,v1=deadbeef"})).status_code == 400

        event = {"id": "evt_1", "type": "checkout.session.completed", "data": {"object": {"client_reference_id": user_id, "customer": "cus_123", "subscription": "sub_1", "metadata": {"plan": "premium"}}}}
        body, header = _signed(event, "whsec_x")
        assert (await user.post(f"{API}/billing/webhook", content=body, headers={"Stripe-Signature": header})).status_code == 200
        assert (await user.get(f"{API}/auth/me")).json()["user"]["plan"] == "premium"

        downgrade = {"id": "evt_2", "type": "customer.subscription.updated", "data": {"object": {"id": "sub_1", "customer": "cus_123", "status": "active", "current_period_end": 1900000000, "items": {"data": [{"price": {"id": "price_pro"}}]}}}}
        body, header = _signed(downgrade, "whsec_x")
        await user.post(f"{API}/billing/webhook", content=body, headers={"Stripe-Signature": header})
        account = (await user.get(f"{API}/account")).json()
        assert account["plan"] == "pro" and account["plan_renews_at"].startswith("2030")

        cancelled = {"id": "evt_3", "type": "customer.subscription.deleted", "data": {"object": {"id": "sub_1", "customer": "cus_123", "status": "canceled"}}}
        body, header = _signed(cancelled, "whsec_x")
        await user.post(f"{API}/billing/webhook", content=body, headers={"Stripe-Signature": header})
        assert (await user.get(f"{API}/auth/me")).json()["user"]["plan"] == "free"

        stale_body, stale_header = _signed(event, "whsec_x", timestamp=int(time.time()) - 3600)
        assert (await user.post(f"{API}/billing/webhook", content=stale_body, headers={"Stripe-Signature": stale_header})).status_code == 400
    finally:
        billing.set_transport(None)
        await user.aclose()


async def test_admin_configures_plan_allowances(app, client, live_quotas):
    original = {p["key"]: p for p in (await client.get(f"{API}/admin/plans")).json()}
    assert original["free"]["zip_searches"] == get_settings().plan_free_zip_searches
    user, _ = await _new_user(app)
    try:
        updated = await client.put(f"{API}/admin/plans/free", json={"price_usd": 0, "zip_searches": 2, "property_reports": 5})
        assert updated.status_code == 200 and updated.json()["zip_searches"] == 2
        assert (await _search(user, "30269")).status_code == 202
        assert (await _search(user, "38116")).status_code == 202  # second ZIP now allowed
        assert (await _search(user, "46201")).status_code == 402
        public = {p["key"]: p for p in (await user.get(f"{API}/account/plans")).json()["plans"]}
        assert public["free"]["zip_searches"] == 2 and public["free"]["zips_per_search"] == 1
        premium = await client.put(f"{API}/admin/plans/premium", json={"price_usd": 59, "zip_searches": None, "property_reports": 400, "zips_per_search": 8})
        assert premium.json()["zip_searches"] is None and premium.json()["zips_per_search"] == 1  # always one ZIP per search
        assert (await user.put(f"{API}/admin/plans/free", json={"price_usd": 0, "zip_searches": 99, "zips_per_search": 1})).status_code == 403
        assert (await client.put(f"{API}/admin/plans/free", json={"price_usd": -1, "zip_searches": 1})).status_code == 422
    finally:
        for key, plan in original.items():
            await client.put(f"{API}/admin/plans/{key}", json={k: plan[k] for k in ("price_usd", "zip_searches", "property_reports")})
        await user.aclose()
