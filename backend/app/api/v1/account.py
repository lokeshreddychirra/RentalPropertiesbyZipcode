"""Plans, the signed-in user's usage, Stripe billing, and the administrator's user list."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import case, func, or_, select

from app.api.deps import AdminUser, CurrentUser, Session, rate_limit
from app.core.config import get_settings
from app.core.errors import AppError, ConflictError, NotFoundError, ServiceUnavailableError
from app.finance.results import Num
from app.models.tables import FavoriteProperty, PlanConfig, SavedSearch, User, UserUsage
from app.services import billing, plans

logger = logging.getLogger(__name__)
router = APIRouter(tags=["account"])


class PlanOut(BaseModel):
    key: str
    name: str
    price_usd: Num
    zip_searches: int | None
    property_reports: int | None
    zips_per_search: int
    monthly: bool
    features: list[str]


class PlansOut(BaseModel):
    plans: list[PlanOut]
    billing_enabled: bool
    quotas_apply: bool


class AccountOut(BaseModel):
    plan: str
    plan_name: str
    unlimited: bool
    period: str
    monthly: bool
    zip_searches_used: int
    zip_searches_limit: int | None
    property_reports_used: int
    property_reports_limit: int | None
    zips_per_search: int
    searched_zips: list[str]
    quotas_apply: bool
    plan_status: str | None
    plan_renews_at: datetime | None
    can_manage_billing: bool


def _plan_out(plan: plans.Plan) -> PlanOut:
    return PlanOut(
        key=plan.key, name=plan.name, price_usd=plan.price_usd, zip_searches=plan.zip_searches, property_reports=plan.property_reports,
        zips_per_search=plan.zips_per_search, monthly=plan.monthly, features=list(plan.features),
    )


@router.get("/account/plans", response_model=PlansOut)
async def list_plans(session: Session) -> PlansOut:
    """The plans on offer, with prices and allowances (public)."""
    await plans.refresh(session)
    return PlansOut(plans=[_plan_out(p) for p in plans.plans().values()], billing_enabled=billing.enabled(), quotas_apply=plans.quotas_apply())


@router.get("/account", response_model=AccountOut)
async def my_account(user: CurrentUser, session: Session) -> AccountOut:
    """The signed-in user's plan and how much of its allowance has been used this period."""
    return AccountOut(**await plans.account_summary(session, user))


class CheckoutRequest(BaseModel):
    plan: Literal["pro", "premium"]


class RedirectOut(BaseModel):
    url: str


@router.post("/billing/checkout", response_model=RedirectOut, dependencies=[rate_limit("billing", 20, 3600)])
async def start_checkout(body: CheckoutRequest, user: CurrentUser, session: Session) -> RedirectOut:
    """Start a Stripe Checkout session for a subscription; the browser is sent to the returned URL."""
    if user.plan == body.plan and user.plan_status in billing.ACTIVE_STATUSES:
        raise ConflictError(f"You are already on the {body.plan.title()} plan.")
    if user.stripe_subscription_id and user.plan_status in billing.ACTIVE_STATUSES:
        return RedirectOut(url=await billing.portal_url(user))  # plan changes go through the portal
    return RedirectOut(url=await billing.checkout_url(session, user, body.plan))


@router.post("/billing/portal", response_model=RedirectOut)
async def billing_portal(user: CurrentUser) -> RedirectOut:
    """Stripe Billing Portal: change plan, update the card, download invoices or cancel."""
    return RedirectOut(url=await billing.portal_url(user))


@router.post("/billing/webhook", include_in_schema=False)
async def stripe_webhook(request: Request, session: Session) -> dict:
    secret = get_settings().stripe_webhook_secret
    if secret is None:
        raise ServiceUnavailableError("Stripe webhooks are not configured")
    event = billing.verify_signature(await request.body(), request.headers.get("Stripe-Signature"), secret.get_secret_value())
    outcome = await billing.handle_event(session, event)
    logger.info("Stripe webhook %s: %s", event.get("id"), outcome)
    return {"received": True}


# ----------------------------------------------------------------------------- administration


class AdminUserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    name: str | None
    role: str
    plan: str
    plan_status: str | None
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None
    login_count: int
    zip_searches_used: int
    property_reports_used: int
    searched_zips: list[str]
    saved_properties: int
    saved_searches: int
    billed_online: bool


class PlanSummary(BaseModel):
    plan: str
    name: str
    users: int
    zip_searches: int  # ZIP codes searched in the current allowance period (lifetime for Free)
    property_reports: int
    revenue_usd: Num


class AdminUsersOut(BaseModel):
    users: list[AdminUserOut]
    total: int
    by_plan: dict[str, int]
    monthly_revenue_usd: Num
    plan_summary: list[PlanSummary]
    zip_searches_this_month: int
    property_reports_this_month: int
    new_users_this_month: int
    active_users_this_month: int


class AdminUserPatch(BaseModel):
    plan: Literal["free", "pro", "premium"] | None = None
    role: Literal["user", "admin"] | None = None
    is_active: bool | None = None
    reset_usage: bool = Field(default=False, description="Clear this period's usage (e.g. after a failed search)")


async def _admin_row(session: Session, user: User) -> AdminUserOut:
    plan = plans.plan_for(user)
    period = plans.current_period(plan)
    zips = await plans.used_items(session, user, plans.ZIP_SEARCH, period)
    favorites = (await session.execute(select(func.count()).select_from(FavoriteProperty).where(FavoriteProperty.user_id == user.id))).scalar_one()
    searches = (await session.execute(select(func.count()).select_from(SavedSearch).where(SavedSearch.user_id == user.id))).scalar_one()
    return AdminUserOut(
        id=user.id, email=user.email, name=user.name, role=user.role, plan=user.plan or "free", plan_status=user.plan_status, is_active=user.is_active,
        created_at=user.created_at, last_login_at=user.last_login_at, login_count=user.login_count or 0, zip_searches_used=len(zips),
        property_reports_used=await plans.usage_count(session, user, plans.PROPERTY_REPORT, period), searched_zips=sorted(zips),
        saved_properties=favorites, saved_searches=searches, billed_online=bool(user.stripe_subscription_id),
    )


class PlanUpdate(BaseModel):
    price_usd: Decimal = Field(ge=0, le=10000)
    zip_searches: int | None = Field(default=None, ge=0, le=100000, description="Distinct ZIP codes per period; null = unlimited")
    property_reports: int | None = Field(default=None, ge=0, le=100000, description="Paid property reports per period; null = unlimited")
    zips_per_search: int | None = Field(default=None, description="Ignored: every search covers exactly one ZIP code")


@router.get("/admin/plans", response_model=list[PlanOut])
async def admin_plans(_: AdminUser, session: Session) -> list[PlanOut]:
    await plans.refresh(session, force=True)
    return [_plan_out(p) for p in plans.plans().values()]


@router.put("/admin/plans/{plan_key}", response_model=PlanOut)
async def admin_update_plan(plan_key: Literal["free", "pro", "premium"], body: PlanUpdate, _: AdminUser, session: Session) -> PlanOut:
    """Change a plan's price and allowances. Takes effect immediately for everyone on the plan.

    The price shown here is for display; the amount actually charged is the Stripe price.
    """
    row = await session.get(PlanConfig, plan_key)
    if row is None:
        row = PlanConfig(key=plan_key)
        session.add(row)
    row.price_usd, row.zip_searches, row.property_reports, row.zips_per_search = body.price_usd, body.zip_searches, body.property_reports, plans.ZIPS_PER_SEARCH
    await session.commit()
    await plans.refresh(session, force=True)
    return _plan_out(plans.plans()[plan_key])


@router.get("/admin/users", response_model=AdminUsersOut)
async def admin_users(
    _: AdminUser, session: Session, q: str | None = Query(default=None, max_length=120), limit: int = Query(default=200, ge=1, le=1000)
) -> AdminUsersOut:
    """Every account with plan, sign-in activity and usage. Passwords are hashed and never returned."""
    query = select(User).order_by(User.created_at.desc()).limit(limit)
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.where(or_(func.lower(User.email).like(like), func.lower(func.coalesce(User.name, "")).like(like)))
    users = (await session.execute(query)).scalars().all()
    await plans.refresh(session)
    counts = dict((await session.execute(select(User.plan, func.count()).group_by(User.plan))).all())
    total = sum(counts.values())
    catalog = plans.plans()
    revenue = sum((catalog[key].price_usd * n for key, n in counts.items() if key in catalog), Decimal("0"))

    # Usage per plan in each plan's own allowance period: lifetime for Free, this month for paid plans.
    now = datetime.now(UTC)
    month = now.strftime("%Y-%m")
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    own_period = case((User.plan == "free", "lifetime"), else_=month)
    usage_rows = (
        await session.execute(
            select(User.plan, UserUsage.kind, func.count())
            .join(User, User.id == UserUsage.user_id)
            .where(UserUsage.period == own_period)
            .group_by(User.plan, UserUsage.kind)
        )
    ).all()
    usage = {(plan, kind): n for plan, kind, n in usage_rows}
    summary = [
        PlanSummary(
            plan=key, name=plan.name, users=counts.get(key, 0), zip_searches=usage.get((key, plans.ZIP_SEARCH), 0),
            property_reports=usage.get((key, plans.PROPERTY_REPORT), 0), revenue_usd=plan.price_usd * counts.get(key, 0),
        )
        for key, plan in catalog.items()
    ]
    month_usage = dict(
        (await session.execute(select(UserUsage.kind, func.count()).where(UserUsage.created_at >= month_start).group_by(UserUsage.kind))).all()
    )
    new_users = (await session.execute(select(func.count()).select_from(User).where(User.created_at >= month_start))).scalar_one()
    active = (await session.execute(select(func.count()).select_from(User).where(User.last_login_at >= month_start))).scalar_one()
    return AdminUsersOut(
        users=[await _admin_row(session, u) for u in users], total=total, by_plan=counts, monthly_revenue_usd=revenue, plan_summary=summary,
        zip_searches_this_month=month_usage.get(plans.ZIP_SEARCH, 0), property_reports_this_month=month_usage.get(plans.PROPERTY_REPORT, 0),
        new_users_this_month=new_users, active_users_this_month=active,
    )


@router.patch("/admin/users/{user_id}", response_model=AdminUserOut)
async def admin_update_user(user_id: uuid.UUID, body: AdminUserPatch, admin: AdminUser, session: Session) -> AdminUserOut:
    """Change a user's plan (manual billing), role or access, or reset this period's usage."""
    user = await session.get(User, user_id)
    if user is None:
        raise NotFoundError("User not found")
    if body.role == "user" and user.role == "admin":
        admins = (await session.execute(select(func.count()).select_from(User).where(User.role == "admin", User.is_active.is_(True)))).scalar_one()
        if admins <= 1:
            raise AppError("At least one administrator is required.", code="last_admin", status_code=409)
    if user.id == admin.id and (body.is_active is False or body.role == "user"):
        raise AppError("You cannot remove your own administrator access.", code="self_lockout", status_code=409)
    if body.plan is not None:
        user.plan = body.plan
        if not user.stripe_subscription_id:
            user.plan_status = "manual" if body.plan != "free" else None
    if body.role is not None:
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.reset_usage:
        period = plans.current_period(plans.plan_for(user))
        rows = (await session.execute(select(UserUsage).where(UserUsage.user_id == user.id, UserUsage.period == period))).scalars().all()
        for row in rows:
            await session.delete(row)
    await session.flush()
    return await _admin_row(session, user)
