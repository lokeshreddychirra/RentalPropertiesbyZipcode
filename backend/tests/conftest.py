"""Test configuration.

Engine tests are pure. API tests need PostgreSQL (with PostGIS) and Redis; they
run against TEST_DATABASE_URL / TEST_REDIS_URL and are skipped if unreachable.
"""

from __future__ import annotations

import os

os.environ["ENVIRONMENT"] = "test"
os.environ["DATA_MODE"] = "demo"
os.environ["JOBS_INLINE"] = "true"
os.environ["RENTCAST_MONTHLY_REQUEST_BUDGET"] = "100000"
os.environ["RENTCAST_MONTHLY_COST_BUDGET_USD"] = "100000"
os.environ["ADMIN_EMAILS"] = '["admin@example.com"]'
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://propertyyield:propertyyield@localhost:5432/propertyyield_test")
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")
for _name in ("RENTCAST_API_KEY", "AIRDNA_API_KEY", "MAPBOX_ACCESS_TOKEN", "ANTHROPIC_API_KEY"):
    os.environ[_name] = ""

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()


@pytest_asyncio.fixture(scope="session")
async def app():
    import app.models  # noqa: F401
    from app.core.db import Base, get_engine
    from app.core.redis import get_redis

    try:
        engine = get_engine()
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        await get_redis().flushdb()
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"PostgreSQL/Redis not available for API tests: {exc}")

    from app.main import create_app

    application = create_app()
    async with application.router.lifespan_context(application):
        yield application


SEARCHER_EMAIL = "searcher@example.com"


async def _searcher_token() -> str:
    """A pre-created administrator used by tests that exercise search (searches need an account)."""
    from sqlalchemy import select

    from app.core.db import session_scope
    from app.core.security import create_access_token, hash_password
    from app.models.tables import User

    async with session_scope() as session:
        user = (await session.execute(select(User).where(User.email == SEARCHER_EMAIL))).scalar_one_or_none()
        if user is None:
            user = User(email=SEARCHER_EMAIL, password_hash=hash_password("searcher-password"), role="admin", plan="free")
            session.add(user)
            await session.flush()
        return create_access_token(str(user.id))


@pytest_asyncio.fixture
async def client(app):
    """Signed in as an administrator (unlimited plan) via a Bearer token."""
    token = await _searcher_token()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"Authorization": f"Bearer {token}"}) as c:
        yield c


@pytest_asyncio.fixture
async def anon_client(app):
    """Not signed in; cookie-based sessions can be created with /auth/register or /auth/login."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
