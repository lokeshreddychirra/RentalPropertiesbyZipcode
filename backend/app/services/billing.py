"""Stripe billing: Checkout for new subscriptions, the Billing Portal for changes, and webhooks.

Only Stripe's REST API is used (form-encoded requests over httpx), so no SDK is needed. Plans are
mapped to Stripe Price IDs through ``STRIPE_PRICE_PRO`` and ``STRIPE_PRICE_PREMIUM``. Without
``STRIPE_SECRET_KEY`` online payment is disabled and an administrator assigns plans by hand.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import AppError, ServiceUnavailableError, UpstreamError
from app.models.tables import User

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = {"active", "trialing", "past_due"}  # past_due keeps access while Stripe retries the card
SIGNATURE_TOLERANCE_SECONDS = 300

_transport: httpx.AsyncBaseTransport | None = None  # tests inject a mock transport


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


def enabled(settings: Settings | None = None) -> bool:
    s = settings or get_settings()
    return bool(s.stripe_secret_key and (s.stripe_price_pro or s.stripe_price_premium))


def price_for(plan: str, settings: Settings | None = None) -> str | None:
    s = settings or get_settings()
    return {"pro": s.stripe_price_pro, "premium": s.stripe_price_premium}.get(plan)


def plan_for_price(price_id: str | None, settings: Settings | None = None) -> str | None:
    s = settings or get_settings()
    mapping = {s.stripe_price_pro: "pro", s.stripe_price_premium: "premium"}
    return mapping.get(price_id) if price_id else None


async def _stripe(method: str, path: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    s = get_settings()
    if not s.stripe_secret_key:
        raise ServiceUnavailableError("Online payments are not set up yet. Contact the site administrator to upgrade.")
    async with httpx.AsyncClient(base_url=s.stripe_api_base, transport=_transport, timeout=20) as client:
        response = await client.request(method, path, data=data, auth=(s.stripe_secret_key.get_secret_value(), ""))
    if response.status_code >= 400:
        try:
            message = response.json().get("error", {}).get("message", "")
        except ValueError:
            message = ""
        logger.warning("Stripe %s %s failed: %s %s", method, path, response.status_code, message)
        raise UpstreamError(f"The payment provider returned an error{': ' + message if message else ''}")
    return response.json()


async def checkout_url(session: AsyncSession, user: User, plan: str) -> str:
    s = get_settings()
    price = price_for(plan)
    if not enabled() or not price:
        raise ServiceUnavailableError("Online payments are not set up yet. Contact the site administrator to upgrade.")
    if not user.stripe_customer_id:
        customer = await _stripe("POST", "/customers", {"email": user.email, "metadata[user_id]": str(user.id)})
        user.stripe_customer_id = customer["id"]
        await session.commit()
    base = s.public_app_url.rstrip("/")
    result = await _stripe(
        "POST",
        "/checkout/sessions",
        {
            "mode": "subscription",
            "customer": user.stripe_customer_id,
            "client_reference_id": str(user.id),
            "line_items[0][price]": price,
            "line_items[0][quantity]": "1",
            "metadata[plan]": plan,
            "subscription_data[metadata][user_id]": str(user.id),
            "allow_promotion_codes": "true",
            "success_url": f"{base}/pricing?checkout=success",
            "cancel_url": f"{base}/pricing?checkout=cancelled",
        },
    )
    return result["url"]


async def portal_url(user: User) -> str:
    if not user.stripe_customer_id:
        raise AppError("There is no billing account for this user yet.", code="no_billing_account", status_code=409)
    base = get_settings().public_app_url.rstrip("/")
    result = await _stripe("POST", "/billing_portal/sessions", {"customer": user.stripe_customer_id, "return_url": f"{base}/pricing"})
    return result["url"]


def verify_signature(payload: bytes, header: str | None, secret: str, now: float | None = None) -> dict[str, Any]:
    """Validate a ``Stripe-Signature`` header (HMAC-SHA256 of ``timestamp.payload``) and parse the event."""
    if not header:
        raise AppError("Missing Stripe signature", code="bad_signature", status_code=400)
    parts: dict[str, list[str]] = {}
    for item in header.split(","):
        key, _, value = item.strip().partition("=")
        parts.setdefault(key, []).append(value)
    try:
        timestamp = int(parts.get("t", [""])[0])
    except ValueError as exc:
        raise AppError("Malformed Stripe signature", code="bad_signature", status_code=400) from exc
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, candidate) for candidate in parts.get("v1", [])):
        raise AppError("Invalid Stripe signature", code="bad_signature", status_code=400)
    if abs((now or time.time()) - timestamp) > SIGNATURE_TOLERANCE_SECONDS:
        raise AppError("Stale Stripe signature", code="bad_signature", status_code=400)
    return json.loads(payload)


async def _user_by_customer(session: AsyncSession, customer_id: str | None) -> User | None:
    if not customer_id:
        return None
    return (await session.execute(select(User).where(User.stripe_customer_id == customer_id))).scalar_one_or_none()


async def handle_event(session: AsyncSession, event: dict[str, Any]) -> str:
    """Apply a webhook event to the matching user. Returns a short description for logging."""
    kind = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    if kind == "checkout.session.completed":
        user = None
        reference = obj.get("client_reference_id")
        try:
            user_id = uuid.UUID(str(reference)) if reference else None
        except ValueError:
            user_id = None
        if user_id:
            user = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        user = user or await _user_by_customer(session, obj.get("customer"))
        if user is None:
            return "checkout for unknown user"
        user.stripe_customer_id = obj.get("customer") or user.stripe_customer_id
        user.stripe_subscription_id = obj.get("subscription") or user.stripe_subscription_id
        plan = (obj.get("metadata") or {}).get("plan")
        if plan in ("pro", "premium"):
            user.plan, user.plan_status = plan, "active"
        return f"checkout completed: {user.email} → {user.plan}"
    if kind in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        user = await _user_by_customer(session, obj.get("customer"))
        if user is None:
            return "subscription for unknown customer"
        status = obj.get("status") or ("canceled" if kind.endswith("deleted") else None)
        items = ((obj.get("items") or {}).get("data")) or []
        plan = plan_for_price(((items[0].get("price") or {}).get("id")) if items else None)
        user.stripe_subscription_id = obj.get("id") or user.stripe_subscription_id
        user.plan_status = status
        period_end = obj.get("current_period_end") or (items[0].get("current_period_end") if items else None)
        user.plan_renews_at = datetime.fromtimestamp(period_end, UTC) if period_end else None
        if kind.endswith("deleted") or status not in ACTIVE_STATUSES:
            user.plan = "free"
        elif plan:
            user.plan = plan
        return f"subscription {status}: {user.email} → {user.plan}"
    return f"ignored {kind}"
