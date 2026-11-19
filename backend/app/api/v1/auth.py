"""Accounts: email + password, session in an httpOnly cookie (or Bearer token).

Passwords are stored only as Argon2id hashes; they cannot be read back by anyone, including
administrators. Sign-in times and counts are recorded for the administrator's user list.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select

from app.api.deps import CurrentUser, OptionalUser, Session, rate_limit
from app.core.config import get_settings
from app.core.errors import ConflictError, ForbiddenError, UnauthorizedError
from app.core.security import create_access_token, hash_password, verify_password
from app.finance.scoring import ScoreWeights
from app.models.tables import User, UserPreference
from app.schemas.analysis import AssumptionOverrides
from app.schemas.search import DefaultFilters, SortKey

router = APIRouter(prefix="/auth", tags=["auth"])


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class RegisterRequest(Credentials):
    name: str | None = Field(default=None, max_length=120)


class UserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    name: str | None
    role: str
    plan: str = "free"


class SessionOut(BaseModel):
    user: UserOut | None
    access_token: str | None = None


class NotificationSettings(BaseModel):
    email_alerts: bool = False
    in_app_alerts: bool = True


class MapPlace(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class SearchDefaults(BaseModel):
    """Applied to every new search: filters (price, beds, returns…), how results are sorted and shown,
    and where the dashboard map starts (None = the user's current location)."""

    filters: DefaultFilters | None = None  # location fields sent here are ignored
    sort: SortKey | None = None
    view: Literal["list", "map", "table"] | None = None
    map_place: MapPlace | None = None


class Preferences(BaseModel):
    """Omitted fields are left unchanged on update."""

    default_assumptions: AssumptionOverrides | None = None  # type: ignore[valid-type]
    score_weights: ScoreWeights | None = None
    notification_settings: NotificationSettings | None = None
    search_defaults: SearchDefaults | None = None


def _clean_search_defaults(value: SearchDefaults | None) -> dict[str, Any]:
    if value is None:
        return {}
    out = value.model_dump(mode="json", exclude_none=True)
    if value.filters is not None:
        filters = value.filters.model_dump(mode="json", exclude_defaults=True)
        if filters:
            out["filters"] = filters
        else:
            out.pop("filters", None)
    return out


def _user_out(user: User) -> UserOut:
    return UserOut(id=user.id, email=user.email, name=user.name, role=user.role, plan=user.plan or "free")


def _set_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.access_token_ttl_minutes * 60,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/register", response_model=SessionOut, status_code=201, dependencies=[rate_limit("register", 10, 3600)])
async def register(body: RegisterRequest, session: Session, response: Response) -> SessionOut:
    settings = get_settings()
    if not settings.allow_registration:
        raise ForbiddenError("Registration is disabled")
    email = body.email.lower()
    if (await session.execute(select(User.id).where(User.email == email))).first():
        raise ConflictError("An account with this email already exists")
    # The first account, and any address listed in ADMIN_EMAILS, administers budgets and the STR registry.
    is_first = (await session.execute(select(func.count()).select_from(User))).scalar_one() == 0
    role = "admin" if is_first or email in {e.lower() for e in settings.admin_emails} else "user"
    user = User(
        email=email, password_hash=hash_password(body.password), name=body.name, role=role, plan="free", last_login_at=datetime.now(UTC), login_count=1
    )
    session.add(user)
    await session.flush()
    token = create_access_token(str(user.id))
    _set_cookie(response, token)
    return SessionOut(user=_user_out(user), access_token=token)


@router.post("/login", response_model=SessionOut, dependencies=[rate_limit("login", 10, 300)])
async def login(body: Credentials, session: Session, response: Response) -> SessionOut:
    user = (await session.execute(select(User).where(User.email == body.email.lower()))).scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise UnauthorizedError("Incorrect email or password")
    user.last_login_at = datetime.now(UTC)
    user.login_count = (user.login_count or 0) + 1
    token = create_access_token(str(user.id))
    _set_cookie(response, token)
    return SessionOut(user=_user_out(user), access_token=token)


@router.post("/logout", status_code=204)
async def logout(response: Response) -> None:
    response.delete_cookie(get_settings().session_cookie_name, path="/")


@router.get("/me", response_model=SessionOut)
async def me(user: OptionalUser) -> SessionOut:
    return SessionOut(user=_user_out(user) if user else None)


def _preferences(row: UserPreference | None) -> Preferences:
    if row is None:
        return Preferences(notification_settings=NotificationSettings())
    return Preferences.model_validate(
        {
            "default_assumptions": row.default_assumptions or None,
            "score_weights": row.score_weights or None,
            "notification_settings": row.notification_settings or {},
            "search_defaults": row.search_defaults or None,
        }
    )


@router.get("/preferences", response_model=Preferences)
async def get_preferences(user: CurrentUser, session: Session) -> Any:
    return _preferences(await session.get(UserPreference, user.id))


@router.put("/preferences", response_model=Preferences)
async def put_preferences(body: Preferences, user: CurrentUser, session: Session) -> Preferences:
    """Update saved defaults. Only the fields present in the request are changed;
    send `null` for `default_assumptions`, `score_weights` or `search_defaults` to clear them."""
    row = await session.get(UserPreference, user.id)
    if row is None:
        row = UserPreference(user_id=user.id, default_assumptions={}, score_weights={}, notification_settings={}, search_defaults={})
        session.add(row)
    sent = body.model_fields_set
    if "default_assumptions" in sent:
        row.default_assumptions = body.default_assumptions.model_dump(mode="json", exclude_none=True) if body.default_assumptions else {}
    if "score_weights" in sent:
        row.score_weights = body.score_weights.model_dump(mode="json") if body.score_weights else {}
    if "notification_settings" in sent and body.notification_settings is not None:
        row.notification_settings = body.notification_settings.model_dump()
    if "search_defaults" in sent:
        row.search_defaults = _clean_search_defaults(body.search_defaults)
    await session.flush()
    return _preferences(row)
