"""Site-wide settings administrators change at runtime, stored in ``app_settings``.

Environment variables provide the defaults. Values are cached in-process for a few seconds so the
API and the worker pick up a change quickly without a database read on every lookup.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.tables import AppSetting

logger = logging.getLogger(__name__)

_REFRESH_SECONDS = 10
_cache: dict[str, Any] = {}
_loaded_at = -1e9


class CacheSettings(BaseModel):
    listing_cache_hours: float = Field(ge=1, le=24 * 30, description="How long listings from the provider count as fresh")
    listing_stale_days: float = Field(
        ge=0, le=30, description="After that, how many more days cached listings are shown instantly while a fresh copy loads in the background (0 = off)"
    )


def default_cache_settings() -> CacheSettings:
    s = get_settings()
    return CacheSettings(listing_cache_hours=round(s.listing_cache_ttl_seconds / 3600, 2), listing_stale_days=s.listing_stale_days)


async def _load(force: bool = False) -> dict[str, Any]:
    global _cache, _loaded_at
    if not force and time.monotonic() - _loaded_at < _REFRESH_SECONDS:
        return _cache
    try:
        async with session_scope() as session:
            rows = (await session.execute(select(AppSetting))).scalars().all()
        _cache = {row.key: row.value for row in rows}
    except Exception:  # pragma: no cover - never fail a search because settings could not be read
        logger.exception("Could not load app settings; using defaults")
    _loaded_at = time.monotonic()
    return _cache


def invalidate() -> None:
    global _loaded_at
    _loaded_at = -1e9


async def cache_settings() -> CacheSettings:
    stored = await _load()
    defaults = default_cache_settings()
    data = defaults.model_dump()
    for name in data:
        value = stored.get(name)
        if isinstance(value, int | float):
            data[name] = value
    try:
        return CacheSettings(**data)
    except ValueError:
        return defaults


async def save_cache_settings(values: CacheSettings) -> CacheSettings:
    async with session_scope() as session:
        for name, value in values.model_dump().items():
            stmt = insert(AppSetting).values(key=name, value=value)
            await session.execute(stmt.on_conflict_do_update(index_elements=[AppSetting.key], set_={"value": value}))
    invalidate()
    return await cache_settings()


async def listing_fresh_seconds() -> float:
    return (await cache_settings()).listing_cache_hours * 3600


async def listing_keep_seconds() -> float:
    """How long a cached listing page is kept at all: fresh period plus the serve-while-refreshing window."""
    settings = await cache_settings()
    return settings.listing_cache_hours * 3600 + settings.listing_stale_days * 86400
