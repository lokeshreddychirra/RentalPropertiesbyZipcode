"""Favorites, watchlists, saved financing scenarios and notifications."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from app.api.deps import CurrentUser, Session
from app.core.errors import ConflictError, NotFoundError
from app.finance.results import Num
from app.finance.scoring import ScoreWeights
from app.models.tables import FavoriteProperty, FinancingScenario, Notification, Property, Watchlist
from app.schemas.analysis import AssumptionOverrides
from app.schemas.search import PropertyCard
from app.services import property_store
from app.services.analysis import analyze
from app.services.search import build_card

router = APIRouter(tags=["saved"])


# --------------------------------------------------------------------------- favorites


class FavoriteIn(BaseModel):
    property_id: uuid.UUID
    watchlist_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=2000)


class FavoritePatch(BaseModel):
    watchlist_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=2000)


class FavoriteOut(BaseModel):
    id: uuid.UUID
    property_id: uuid.UUID
    watchlist_id: uuid.UUID | None
    notes: str | None
    created_at: datetime
    card: PropertyCard | None = None


class FavoritesQuery(BaseModel):
    defaults: AssumptionOverrides | None = None  # type: ignore[valid-type]
    weights: ScoreWeights | None = None


async def _favorites(session: Session, user_id: uuid.UUID, body: FavoritesQuery | None) -> list[FavoriteOut]:
    rows = (await session.execute(select(FavoriteProperty).where(FavoriteProperty.user_id == user_id).order_by(FavoriteProperty.created_at.desc()))).scalars().all()
    contexts = await property_store.load_contexts(session, [row.property_id for row in rows])
    out = []
    for row in rows:
        ctx = contexts.get(row.property_id)
        card = None
        if ctx is not None and ctx.price is not None:
            card = build_card(ctx, analyze(ctx, defaults=body.defaults if body else None, weights=body.weights if body else None))
        out.append(FavoriteOut(id=row.id, property_id=row.property_id, watchlist_id=row.watchlist_id, notes=row.notes, created_at=row.created_at, card=card))
    return out


@router.get("/favorites", response_model=list[FavoriteOut])
async def list_favorites(user: CurrentUser, session: Session) -> list[FavoriteOut]:
    """Saved properties with current metrics under default assumptions."""
    return await _favorites(session, user.id, None)


@router.post("/favorites/query", response_model=list[FavoriteOut])
async def query_favorites(body: FavoritesQuery, user: CurrentUser, session: Session) -> list[FavoriteOut]:
    """Saved properties re-evaluated with the caller's standing assumptions and score weights."""
    return await _favorites(session, user.id, body)


@router.get("/favorites/ids", response_model=list[uuid.UUID])
async def favorite_ids(user: CurrentUser, session: Session) -> list[uuid.UUID]:
    return list((await session.execute(select(FavoriteProperty.property_id).where(FavoriteProperty.user_id == user.id))).scalars())


async def _own_watchlist(session: Session, user_id: uuid.UUID, watchlist_id: uuid.UUID | None) -> None:
    if watchlist_id is None:
        return
    watchlist = await session.get(Watchlist, watchlist_id)
    if watchlist is None or watchlist.user_id != user_id:
        raise NotFoundError("Watchlist not found")


@router.post("/favorites", response_model=FavoriteOut, status_code=201)
async def add_favorite(body: FavoriteIn, user: CurrentUser, session: Session) -> FavoriteOut:
    if await session.get(Property, body.property_id) is None:
        raise NotFoundError("Property not found")
    await _own_watchlist(session, user.id, body.watchlist_id)
    stmt = insert(FavoriteProperty).values(id=uuid.uuid4(), user_id=user.id, property_id=body.property_id, watchlist_id=body.watchlist_id, notes=body.notes)
    stmt = stmt.on_conflict_do_update(index_elements=["user_id", "property_id"], set_=dict(watchlist_id=stmt.excluded.watchlist_id, notes=stmt.excluded.notes)).returning(FavoriteProperty)
    row = (await session.execute(stmt)).scalar_one()
    return FavoriteOut(id=row.id, property_id=row.property_id, watchlist_id=row.watchlist_id, notes=row.notes, created_at=row.created_at)


@router.patch("/favorites/{property_id}", response_model=FavoriteOut)
async def update_favorite(property_id: uuid.UUID, body: FavoritePatch, user: CurrentUser, session: Session) -> FavoriteOut:
    row = (await session.execute(select(FavoriteProperty).where(FavoriteProperty.user_id == user.id, FavoriteProperty.property_id == property_id))).scalar_one_or_none()
    if row is None:
        raise NotFoundError("Saved property not found")
    data = body.model_dump(exclude_unset=True)
    if "watchlist_id" in data:
        await _own_watchlist(session, user.id, data["watchlist_id"])
        row.watchlist_id = data["watchlist_id"]
    if "notes" in data:
        row.notes = data["notes"]
    await session.flush()
    return FavoriteOut(id=row.id, property_id=row.property_id, watchlist_id=row.watchlist_id, notes=row.notes, created_at=row.created_at)


@router.delete("/favorites/{property_id}", status_code=204)
async def remove_favorite(property_id: uuid.UUID, user: CurrentUser, session: Session) -> None:
    row = (await session.execute(select(FavoriteProperty).where(FavoriteProperty.user_id == user.id, FavoriteProperty.property_id == property_id))).scalar_one_or_none()
    if row is not None:
        await session.delete(row)


# --------------------------------------------------------------------------- watchlists


class WatchlistIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WatchlistOut(BaseModel):
    id: uuid.UUID
    name: str
    property_count: int = 0


@router.get("/watchlists", response_model=list[WatchlistOut])
async def list_watchlists(user: CurrentUser, session: Session) -> list[WatchlistOut]:
    rows = (
        await session.execute(
            select(Watchlist, func.count(FavoriteProperty.id)).outerjoin(FavoriteProperty, FavoriteProperty.watchlist_id == Watchlist.id).where(Watchlist.user_id == user.id).group_by(Watchlist.id).order_by(Watchlist.name)
        )
    ).all()
    return [WatchlistOut(id=w.id, name=w.name, property_count=count) for w, count in rows]


@router.post("/watchlists", response_model=WatchlistOut, status_code=201)
async def create_watchlist(body: WatchlistIn, user: CurrentUser, session: Session) -> WatchlistOut:
    if (await session.execute(select(Watchlist.id).where(Watchlist.user_id == user.id, Watchlist.name == body.name))).first():
        raise ConflictError("You already have a watchlist with this name")
    row = Watchlist(user_id=user.id, name=body.name)
    session.add(row)
    await session.flush()
    return WatchlistOut(id=row.id, name=row.name)


@router.delete("/watchlists/{watchlist_id}", status_code=204)
async def delete_watchlist(watchlist_id: uuid.UUID, user: CurrentUser, session: Session) -> None:
    row = await session.get(Watchlist, watchlist_id)
    if row is None or row.user_id != user.id:
        raise NotFoundError("Watchlist not found")
    await session.delete(row)


# --------------------------------------------------------------------------- financing scenarios


class FinancingIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    down_payment_pct: Num = Field(ge=0, le=100)
    interest_rate_pct: Num = Field(ge=0, le=30)
    loan_term_years: int = Field(ge=1, le=40)
    property_id: uuid.UUID | None = None


class FinancingOut(FinancingIn):
    id: uuid.UUID


@router.get("/financing-scenarios", response_model=list[FinancingOut])
async def list_financing(user: CurrentUser, session: Session) -> list[Any]:
    rows = (await session.execute(select(FinancingScenario).where(FinancingScenario.user_id == user.id).order_by(FinancingScenario.created_at))).scalars()
    return [FinancingOut(id=r.id, name=r.name, down_payment_pct=r.down_payment_pct, interest_rate_pct=r.interest_rate_pct, loan_term_years=r.loan_term_years, property_id=r.property_id) for r in rows]


@router.post("/financing-scenarios", response_model=FinancingOut, status_code=201)
async def create_financing(body: FinancingIn, user: CurrentUser, session: Session) -> FinancingOut:
    row = FinancingScenario(user_id=user.id, **body.model_dump())
    session.add(row)
    await session.flush()
    return FinancingOut(id=row.id, **body.model_dump())


@router.delete("/financing-scenarios/{scenario_id}", status_code=204)
async def delete_financing(scenario_id: uuid.UUID, user: CurrentUser, session: Session) -> None:
    row = await session.get(FinancingScenario, scenario_id)
    if row is None or row.user_id != user.id:
        raise NotFoundError("Financing scenario not found")
    await session.delete(row)


# --------------------------------------------------------------------------- notifications


class NotificationOut(BaseModel):
    id: uuid.UUID
    type: str
    title: str
    body: str
    property_id: uuid.UUID | None
    saved_search_id: uuid.UUID | None
    payload: dict[str, Any]
    created_at: datetime
    read_at: datetime | None


class NotificationList(BaseModel):
    items: list[NotificationOut]
    unread: int


@router.get("/notifications", response_model=NotificationList)
async def list_notifications(user: CurrentUser, session: Session, limit: int = 50) -> NotificationList:
    rows = (await session.execute(select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(min(max(limit, 1), 200)))).scalars().all()
    unread = (await session.execute(select(func.count()).select_from(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None)))).scalar_one()
    return NotificationList(
        items=[NotificationOut(id=r.id, type=r.type, title=r.title, body=r.body, property_id=r.property_id, saved_search_id=r.saved_search_id, payload=r.payload, created_at=r.created_at, read_at=r.read_at) for r in rows],
        unread=unread,
    )


@router.post("/notifications/read-all", status_code=204)
async def mark_all_read(user: CurrentUser, session: Session) -> None:
    await session.execute(update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None)).values(read_at=datetime.now(UTC)))


@router.post("/notifications/{notification_id}/read", status_code=204)
async def mark_read(notification_id: uuid.UUID, user: CurrentUser, session: Session) -> None:
    await session.execute(update(Notification).where(Notification.id == notification_id, Notification.user_id == user.id).values(read_at=datetime.now(UTC)))
