"""Dispatch of background search jobs to the Redis-backed worker (arq)."""

from __future__ import annotations

import asyncio
import logging

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_pool: ArqRedis | None = None
_inline_tasks: set[asyncio.Task] = set()


def redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


async def _get_pool() -> ArqRedis:
    global _pool
    if _pool is None:
        _pool = await create_pool(redis_settings())
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.aclose()
    _pool = None


async def enqueue_search(job_id: str) -> None:
    """Queue a search job; with JOBS_INLINE=true it runs as a task in this process instead."""
    if get_settings().jobs_inline:
        from app.services.search import run_search_job

        task = asyncio.create_task(run_search_job(job_id))
        _inline_tasks.add(task)
        task.add_done_callback(_inline_tasks.discard)
        return
    pool = await _get_pool()
    await pool.enqueue_job("run_search_job", job_id, _job_id=f"search:{job_id}")
