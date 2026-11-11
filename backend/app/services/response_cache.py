"""Persistent, shared cache for paid provider responses.

Listing pages bought from a provider are stored in PostgreSQL so every user searching the same area
reuses them, and a Redis restart or memory eviction never triggers a repeat paid request.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from app.core.db import session_scope
from app.models.tables import ProviderResponseCache


async def get_json(key: str) -> Any | None:
    """The cached payload for ``key`` if it has not expired."""
    async with session_scope() as session:
        row = await session.scalar(
            select(ProviderResponseCache.payload).where(ProviderResponseCache.key == key, ProviderResponseCache.expires_at > datetime.now(UTC))
        )
    return row


async def set_json(key: str, value: Any, ttl_seconds: int) -> None:
    """Store ``value`` under ``key`` for ``ttl_seconds`` and drop rows that expired more than a day ago."""
    now = datetime.now(UTC)
    kind = key.split(":", 1)[0][:20]
    expires = now + timedelta(seconds=max(ttl_seconds, 1))
    stmt = insert(ProviderResponseCache).values(key=key, kind=kind, payload=value, expires_at=expires)
    stmt = stmt.on_conflict_do_update(index_elements=[ProviderResponseCache.key], set_={"payload": value, "expires_at": expires, "kind": kind})
    async with session_scope() as session:
        await session.execute(stmt)
        await session.execute(delete(ProviderResponseCache).where(ProviderResponseCache.expires_at < now - timedelta(days=1)))
