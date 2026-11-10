"""Saved-search alerts: scheduled checks with idempotent notifications.

For every saved search with alerts enabled the worker re-runs the search and
compares the result with the listings it has already seen:

    new_listing           a qualifying property not seen before
    price_reduction       a known property whose asking price dropped
    cash_flow_threshold   primary-strategy monthly cash flow ≥ the saved threshold
    yield_threshold       primary-strategy gross yield ≥ the saved threshold

Each event has a deterministic dedupe key and notifications are inserted with
``ON CONFLICT DO NOTHING`` on (user_id, dedupe_key), so the same event is never
stored or emailed twice — even if checks overlap or are retried. The first check
of a search only records a baseline (no "new listing" flood).
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from email.message import EmailMessage
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.tables import Notification, SavedSearch, User, UserPreference
from app.schemas.analysis import AssumptionOverrides
from app.schemas.search import JobProgress, PropertyCard, SearchFilters, SearchRunRequest
from app.services.search import _view, execute_search, filter_cards

logger = logging.getLogger(__name__)


def _money(value: Any) -> str:
    return f"${Decimal(str(value)):,.0f}"


def detect_events(search: SavedSearch, cards: list[PropertyCard], strategy: str) -> tuple[list[dict[str, Any]], dict[str, float]]:
    """Pure function: (events, new known-listings map). Events carry their dedupe keys."""
    known: dict[str, float] = dict(search.known_listings or {})
    baseline = search.last_checked_at is None
    events: list[dict[str, Any]] = []
    current: dict[str, float] = {}

    for card in cards:
        pid = str(card.id)
        price = float(card.price) if card.price is not None else 0.0
        current[pid] = price
        address = card.address_line1 or card.formatted_address
        view = _view(card, strategy)
        previous = known.get(pid)

        if previous is None and not baseline and search.notify_new_listings:
            events.append(dict(type="new_listing", property_id=card.id, dedupe_key=f"new:{search.id}:{pid}", title=f"New match: {address}", body=f"{card.formatted_address} is listed at {_money(price)} and matches “{search.name}”.", payload={"price": price}))
        if previous is not None and price and price < previous and search.notify_price_reductions:
            drop = (previous - price) / previous * 100
            events.append(dict(type="price_reduction", property_id=card.id, dedupe_key=f"price:{search.id}:{pid}:{int(price)}", title=f"Price reduced: {address}", body=f"Asking price dropped {drop:.1f}% from {_money(previous)} to {_money(price)}.", payload={"previous_price": previous, "price": price}))
        if view is not None and view.available:
            if search.cash_flow_threshold is not None and view.monthly_cash_flow is not None and view.monthly_cash_flow >= search.cash_flow_threshold:
                events.append(dict(type="cash_flow_threshold", property_id=card.id, dedupe_key=f"cf:{search.id}:{pid}:{search.cash_flow_threshold}", title=f"Cash-flow target met: {address}", body=f"Estimated cash flow of {_money(view.monthly_cash_flow)}/month meets your {_money(search.cash_flow_threshold)} target.", payload={"monthly_cash_flow": float(view.monthly_cash_flow)}))
            if search.gross_yield_threshold is not None and view.gross_yield_pct is not None and view.gross_yield_pct >= search.gross_yield_threshold:
                events.append(dict(type="yield_threshold", property_id=card.id, dedupe_key=f"yield:{search.id}:{pid}:{search.gross_yield_threshold}", title=f"Yield target met: {address}", body=f"Estimated gross yield of {view.gross_yield_pct}% meets your {search.gross_yield_threshold}% target.", payload={"gross_yield_pct": float(view.gross_yield_pct)}))
    return events, current


async def check_saved_search(search_id: uuid.UUID) -> int:
    """Run one saved search and store any new notifications. Returns how many were created."""
    async with session_scope() as session:
        search = await session.get(SavedSearch, search_id)
        if search is None or not search.alerts_enabled:
            return 0
        filters = SearchFilters.model_validate(search.filters)
        defaults = AssumptionOverrides.model_validate(search.overrides) if search.overrides else None
        user_id = search.user_id

    async def quiet(_: JobProgress) -> None:
        return None

    outcome = await execute_search(SearchRunRequest(filters=filters, defaults=defaults), quiet)
    if outcome.partial_reasons:
        # Never treat an incomplete fetch as "these listings disappeared / are new".
        logger.info("Alert check for %s skipped: partial results (%s)", search_id, outcome.partial_reasons[0])
        return 0
    cards = filter_cards(outcome.cards, filters)

    created: list[dict[str, Any]] = []
    async with session_scope() as session:
        search = await session.get(SavedSearch, search_id, with_for_update=True)
        if search is None:
            return 0
        events, current = detect_events(search, cards, filters.strategy)
        for event in events:
            stmt = (
                insert(Notification)
                .values(id=uuid.uuid4(), user_id=user_id, saved_search_id=search.id, **event)
                .on_conflict_do_nothing(index_elements=["user_id", "dedupe_key"])
                .returning(Notification.id)
            )
            if (await session.execute(stmt)).first() is not None:
                created.append(event)
        search.known_listings = current
        search.last_checked_at = datetime.now(UTC)
        name = search.name

    if created:
        await _email_digest(user_id, name, created)
    return len(created)


async def check_due_saved_searches() -> int:
    settings = get_settings()
    if not settings.alerts_enabled:
        return 0
    cutoff = datetime.now(UTC) - timedelta(minutes=settings.alerts_interval_minutes)
    async with session_scope() as session:
        ids = list(
            (
                await session.execute(
                    select(SavedSearch.id).where(SavedSearch.alerts_enabled.is_(True), (SavedSearch.last_checked_at.is_(None)) | (SavedSearch.last_checked_at < cutoff)).order_by(SavedSearch.last_checked_at.asc().nullsfirst()).limit(50)
                )
            ).scalars()
        )
    total = 0
    for search_id in ids:
        try:
            total += await check_saved_search(search_id)
        except Exception:
            logger.exception("Alert check failed for saved search %s", search_id)
    return total


async def _email_digest(user_id: uuid.UUID, search_name: str, events: list[dict[str, Any]]) -> None:
    settings = get_settings()
    if not (settings.smtp_host and settings.smtp_from):
        return
    async with session_scope() as session:
        user = await session.get(User, user_id)
        prefs = await session.get(UserPreference, user_id)
    if user is None or not (prefs and (prefs.notification_settings or {}).get("email_alerts")):
        return

    message = EmailMessage()
    message["Subject"] = f"PropertyYield AI: {len(events)} update(s) for “{search_name}”"
    message["From"] = settings.smtp_from
    message["To"] = user.email
    lines = [f"Updates for your saved search “{search_name}”:", ""]
    for event in events[:40]:
        lines += [f"• {event['title']}", f"  {event['body']}", f"  {settings.public_app_url}/properties/{event['property_id']}", ""]
    lines.append("Figures are estimates and must be verified. Manage alerts under Saved Properties.")
    message.set_content("\n".join(lines))

    def send() -> None:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
            smtp.starttls()
            if settings.smtp_username and settings.smtp_password:
                smtp.login(settings.smtp_username, settings.smtp_password.get_secret_value())
            smtp.send_message(message)

    try:
        await asyncio.to_thread(send)
        async with session_scope() as session:
            await session.execute(
                update(Notification).where(Notification.user_id == user_id, Notification.dedupe_key.in_([e["dedupe_key"] for e in events])).values(emailed_at=datetime.now(UTC))
            )
    except Exception:
        logger.exception("Could not send alert email to user %s", user_id)
