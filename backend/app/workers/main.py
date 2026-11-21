"""Redis-backed background worker (arq).

Run with:  arq app.workers.main.WorkerSettings

Jobs
    run_search_job    execute a property search and publish progress
Cron
    check_alerts      re-run saved searches that have alerts enabled
"""

from __future__ import annotations

import logging
from typing import Any

from arq import cron

from app.core.config import get_settings
from app.core.db import dispose_engine
from app.core.redis import close_redis
from app.providers.registry import get_providers, set_providers
from app.providers.usage import ensure_providers_seeded
from app.services.alerts import check_due_saved_searches
from app.services.jobs import redis_settings
from app.services.search import run_search_job as _run_search_job

logger = logging.getLogger(__name__)


async def run_search_job(ctx: dict[str, Any], job_id: str) -> None:
    await _run_search_job(job_id)


async def check_alerts(ctx: dict[str, Any]) -> int:
    created = await check_due_saved_searches()
    if created:
        logger.info("Created %s alert notification(s)", created)
    return created


async def startup(ctx: dict[str, Any]) -> None:
    logging.basicConfig(level=get_settings().log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    await ensure_providers_seeded()
    get_providers()


async def shutdown(ctx: dict[str, Any]) -> None:
    await get_providers().aclose()
    set_providers(None)
    await close_redis()
    await dispose_engine()


class WorkerSettings:
    functions = [run_search_job]
    # The cron wakes every 15 minutes; each saved search is only re-checked once per ALERTS_INTERVAL_MINUTES.
    cron_jobs = [cron(check_alerts, minute={0, 15, 30, 45}, run_at_startup=False, unique=True)]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = redis_settings()
    max_jobs = 4
    job_timeout = 900
    keep_result = 60
