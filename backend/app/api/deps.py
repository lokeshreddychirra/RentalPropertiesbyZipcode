"""Shared API dependencies: database session, authentication, rate limiting."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_session
from app.core.errors import ForbiddenError, RateLimitedError, UnauthorizedError
from app.core.redis import get_redis
from app.core.security import decode_access_token
from app.models.tables import User

Session = Annotated[AsyncSession, Depends(get_session)]


def _token_from(request: Request) -> str | None:
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(get_settings().session_cookie_name)


async def get_optional_user(request: Request, session: Session) -> User | None:
    token = _token_from(request)
    if not token:
        return None
    user_id = decode_access_token(token)
    if not user_id:
        return None
    try:
        key = uuid.UUID(user_id)
    except ValueError:
        return None
    user = (await session.execute(select(User).where(User.id == key))).scalar_one_or_none()
    return user if user and user.is_active else None


async def get_current_user(user: Annotated[User | None, Depends(get_optional_user)]) -> User:
    if user is None:
        raise UnauthorizedError("Sign in to use this feature")
    return user


async def get_admin_user(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "admin":
        raise ForbiddenError("Administrator access is required")
    return user


OptionalUser = Annotated[User | None, Depends(get_optional_user)]
CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser = Annotated[User, Depends(get_admin_user)]


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(name: str, limit: int, window_seconds: int):
    """Fixed-window limiter keyed by client IP. Fails open if Redis is unavailable."""

    async def dependency(request: Request) -> None:
        key = f"ratelimit:{name}:{client_ip(request)}"
        try:
            redis = get_redis()
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, window_seconds)
        except Exception:
            return
        if count > limit:
            raise RateLimitedError("Too many requests — please slow down and try again shortly", details={"retry_after_seconds": window_seconds})

    return Depends(dependency)
