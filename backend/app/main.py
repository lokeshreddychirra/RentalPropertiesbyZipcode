"""PropertyYield AI — FastAPI application."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.v1 import account, analysis, auth, favorites, market, properties, searches, system
from app.core.config import get_settings
from app.core.db import dispose_engine, session_scope
from app.core.errors import install_error_handlers
from app.core.redis import close_redis, get_redis
from app.providers.registry import get_providers, set_providers
from app.providers.usage import ensure_providers_seeded
from app.services.jobs import close_pool

logger = logging.getLogger(__name__)

DESCRIPTION = """
Real-estate investment analysis API.

* **Listings** come from licensed providers through adapters (RentCast today; MLS/RESO feeds can be added).
* **Returns** are calculated by a deterministic Decimal engine — the LLM only explains results.
* **Every figure** is labelled as verified, estimated, default or user-entered, and demo data is always flagged.

Errors use the shape `{"error": {"code", "message", "details"}}`.
"""


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings.validate_for_production()
    await ensure_providers_seeded()
    providers = get_providers()
    logger.info("PropertyYield AI started in %s data mode", providers.mode)
    yield
    await providers.aclose()
    set_providers(None)
    await close_pool()
    await close_redis()
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="PropertyYield AI API",
        version="1.0.0",
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    install_error_handlers(app)

    v1 = APIRouter(prefix=settings.api_prefix)
    for module in (auth, account, properties, searches, analysis, market, favorites, system):
        v1.include_router(module.router)
    app.include_router(v1)

    @app.get("/healthz", tags=["health"], summary="Liveness probe")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", tags=["health"], summary="Readiness probe (database and Redis reachable)")
    async def readyz() -> dict[str, str]:
        async with session_scope() as session:
            await session.execute(text("SELECT 1"))
        await get_redis().ping()
        return {"status": "ready"}

    return app


app = create_app()
