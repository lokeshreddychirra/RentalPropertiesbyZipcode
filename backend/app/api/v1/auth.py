"""Optional accounts: email + password, session in an httpOnly cookie (or Bearer token)."""

from __future__ import annotations

import uuid
from typing import Any

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


class SessionOut(BaseModel):
    user: UserOut | None
    access_token: str | None = None


class NotificationSettings(BaseModel):
    email_alerts: bool = False
    in_app_alerts: bool = True


class Preferences(BaseModel):
    default_assumptions: AssumptionOverrides | None = None  # type: ignore[valid-type]
    score_weights: ScoreWeights | None = None
    notification_settings: NotificationSettings = Field(default_factory=NotificationSettings)


def _user_out(user: User) -> UserOut:
    return UserOut(id=user.id, email=user.email, name=user.name, role=user.role)


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
    user = User(email=email, password_hash=hash_password(body.password), name=body.name, role=role)
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
    token = create_access_token(str(user.id))
    _set_cookie(response, token)
    return SessionOut(user=_user_out(user), access_token=token)


@router.post("/logout", status_code=204)
async def logout(response: Response) -> None:
    response.delete_cookie(get_settings().session_cookie_name, path="/")


@router.get("/me", response_model=SessionOut)
async def me(user: OptionalUser) -> SessionOut:
    return SessionOut(user=_user_out(user) if user else None)


@router.get("/preferences", response_model=Preferences)
async def get_preferences(user: CurrentUser, session: Session) -> Any:
    row = await session.get(UserPreference, user.id)
    if row is None:
        return Preferences()
    return Preferences.model_validate(
        {
            "default_assumptions": row.default_assumptions or None,
            "score_weights": row.score_weights or None,
            "notification_settings": row.notification_settings or {},
        }
    )


@router.put("/preferences", response_model=Preferences)
async def put_preferences(body: Preferences, user: CurrentUser, session: Session) -> Preferences:
    row = await session.get(UserPreference, user.id)
    if row is None:
        row = UserPreference(user_id=user.id)
        session.add(row)
    row.default_assumptions = body.default_assumptions.model_dump(mode="json", exclude_none=True) if body.default_assumptions else {}
    row.score_weights = body.score_weights.model_dump(mode="json") if body.score_weights else {}
    row.notification_settings = body.notification_settings.model_dump()
    return body
