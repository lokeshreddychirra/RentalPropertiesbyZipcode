"""Persistent, shared cache for paid provider responses.

Listing pages bought from a provider are stored in PostgreSQL so every user searching the same area
reuses them, and a Redis restart or memory eviction never triggers a repeat paid request.

Each row records when it was fetched. Whether it still counts as *fresh* is worked out when it is read,
from the administrator's current setting, so changing the setting applies to rows already cached. A
row older than that is *stale*: searches may still show it instantly while a fresh copy is fetched in
the background. Rows are purged once they are older than the fresh period plus that stale window.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from app.core.db import session_scope
from app.models.tables import ProviderResponseCache

from . import runtime_settings


@dataclass
class CacheEntry:
    payload: Any
    fetched_at: datetime
    fresh: bool


async def get_entry(key: str, *, fresh_seconds: float | None = None) -> CacheEntry | None:
    """The cached payload for ``key`` with its age, or None if there is none (or it was purged)."""
    now = datetime.now(UTC)
    async with session_scope() as session:
        row = (
            await session.execute(
                select(ProviderResponseCache.payload, ProviderResponseCache.fetched_at).where(ProviderResponseCache.key == key, ProviderResponseCache.expires_at > now)
            )
        ).first()
    if row is None:
        return None
    if fresh_seconds is None:
        fresh_seconds = await runtime_settings.listing_fresh_seconds()
    return CacheEntry(payload=row.payload, fetched_at=row.fetched_at, fresh=row.fetched_at > now - timedelta(seconds=fresh_seconds))


async def get_json(key: str) -> Any | None:
    """The cached payload for ``key`` only if it is still fresh."""
    entry = await get_entry(key)
    return entry.payload if entry and entry.fresh else None


async def set_json(key: str, value: Any, keep_seconds: float | None = None) -> None:
    """Store ``value`` under ``key`` (fetched now) and purge rows past their keep period."""
    now = datetime.now(UTC)
    if keep_seconds is None:
        keep_seconds = await runtime_settings.listing_keep_seconds()
    kind = key.split(":", 1)[0][:20]
    expires = now + timedelta(seconds=max(keep_seconds, 1))
    stmt = insert(ProviderResponseCache).values(key=key, kind=kind, payload=value, expires_at=expires, fetched_at=now)
    stmt = stmt.on_conflict_do_update(index_elements=[ProviderResponseCache.key], set_={"payload": value, "expires_at": expires, "kind": kind, "fetched_at": now})
    async with session_scope() as session:
        await session.execute(stmt)
        await session.execute(delete(ProviderResponseCache).where(ProviderResponseCache.expires_at < now))
