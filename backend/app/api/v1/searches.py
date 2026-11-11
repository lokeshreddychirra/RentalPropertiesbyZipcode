"""Search execution (background jobs with progress), natural-language parsing and saved searches."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, Session, rate_limit
from app.core.errors import AppError, NotFoundError
from app.models.tables import SavedSearch
from app.schemas.analysis import AssumptionOverrides
from app.schemas.search import MapResults, SearchFilters, SearchJob, SearchResults, SearchRunRequest, SortKey
from app.services import plans
from app.services import search as search_service
from app.services.jobs import enqueue_search
from app.services.nl_search import NLParseResult, parse_query

router = APIRouter(prefix="/searches", tags=["searches"])


def parse_bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if not value:
        return None
    try:
        west, south, east, north = (float(part) for part in value.split(","))
    except ValueError as exc:
        raise AppError("bbox must be 'west,south,east,north'", code="validation_error", status_code=422) from exc
    return west, south, east, north


def parse_polygon(value: str | None) -> list[tuple[float, float]] | None:
    if not value:
        return None
    try:
        points = [(float(lng), float(lat)) for lng, lat in (pair.split(",") for pair in value.split(";"))]
    except ValueError as exc:
        raise AppError("polygon must be 'lng,lat;lng,lat;…'", code="validation_error", status_code=422) from exc
    if not 3 <= len(points) <= 200:
        raise AppError("polygon must have between 3 and 200 vertices", code="validation_error", status_code=422)
    return points


@router.post("/run", response_model=SearchJob, status_code=202, dependencies=[rate_limit("search", 40, 60)])
async def run_search(body: SearchRunRequest, user: CurrentUser, session: Session) -> SearchJob:
    """Start a property search as a background job. Poll the job for progress, then read its results.

    Requires an account. Searches are by ZIP code and count against the user's plan (distinct ZIP codes
    per period). An identical recent search returns its existing job (served from cache) unless
    `refresh` is set — which only administrators may do.
    """
    await plans.authorize_search(session, user, body.filters)
    if body.refresh and not plans.is_unlimited(user):
        body = body.model_copy(update={"refresh": False})
    job, needs_run = await search_service.create_job(body)
    if needs_run:
        await enqueue_search(job.id)
    return job


@router.get("/jobs/{job_id}", response_model=SearchJob)
async def get_job(job_id: str) -> SearchJob:
    job = await search_service.load_job(job_id)
    if job is None:
        raise NotFoundError("Search job not found or expired — run the search again")
    return job


@router.get("/jobs/{job_id}/results", response_model=SearchResults)
async def get_results(
    job_id: str,
    sort: SortKey = "score",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 24,
    bbox: Annotated[str | None, Query(description="Limit to a map viewport: west,south,east,north")] = None,
    polygon: Annotated[str | None, Query(description="Limit to a drawn area: lng,lat;lng,lat;…")] = None,
) -> SearchResults:
    job = await search_service.load_job(job_id)
    if job is None:
        raise NotFoundError("Search job not found or expired — run the search again")
    if job.status != "completed":
        raise AppError("The search has not finished yet", code="search_not_ready", status_code=409, details={"status": job.status})
    cards = await search_service.load_cards(job_id)
    if cards is None:
        raise NotFoundError("Search results have expired — run the search again")
    return search_service.page_results(job, cards, sort=sort, page=page, page_size=page_size, bbox=parse_bbox(bbox), polygon=parse_polygon(polygon))


@router.get("/jobs/{job_id}/map", response_model=MapResults)
async def get_map_points(job_id: str) -> MapResults:
    """Lightweight coordinates + headline metrics for every matching property (for map rendering)."""
    job = await search_service.load_job(job_id)
    if job is None or job.status != "completed":
        raise NotFoundError("Search results are not available — run the search again")
    cards = await search_service.load_cards(job_id)
    if cards is None:
        raise NotFoundError("Search results have expired — run the search again")
    return search_service.map_points(job, cards)


class ParseRequest(BaseModel):
    query: str = Field(min_length=3, max_length=500)


@router.post("/parse", response_model=NLParseResult, dependencies=[rate_limit("nl", 30, 60)])
async def parse_natural_language(body: ParseRequest) -> NLParseResult:
    """Convert a natural-language request into validated search filters.

    Criteria that cannot be reliably calculated are returned in `unsupported` with an explanation.
    """
    return await parse_query(body.query)


# --------------------------------------------------------------------------- saved searches


class SavedSearchIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    filters: SearchFilters
    defaults: AssumptionOverrides | None = None  # type: ignore[valid-type]
    alerts_enabled: bool = False
    notify_new_listings: bool = True
    notify_price_reductions: bool = True
    cash_flow_threshold: Decimal | None = Field(default=None, ge=-100000, le=1000000)
    gross_yield_threshold: Decimal | None = Field(default=None, ge=0, le=1000)


class SavedSearchPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    alerts_enabled: bool | None = None
    notify_new_listings: bool | None = None
    notify_price_reductions: bool | None = None
    cash_flow_threshold: Decimal | None = None
    gross_yield_threshold: Decimal | None = None


class SavedSearchOut(BaseModel):
    id: uuid.UUID
    name: str
    filters: dict[str, Any]
    defaults: dict[str, Any]
    alerts_enabled: bool
    notify_new_listings: bool
    notify_price_reductions: bool
    cash_flow_threshold: float | None
    gross_yield_threshold: float | None
    last_checked_at: datetime | None
    created_at: datetime


def _out(row: SavedSearch) -> SavedSearchOut:
    return SavedSearchOut(
        id=row.id,
        name=row.name,
        filters=row.filters,
        defaults=row.overrides or {},
        alerts_enabled=row.alerts_enabled,
        notify_new_listings=row.notify_new_listings,
        notify_price_reductions=row.notify_price_reductions,
        cash_flow_threshold=float(row.cash_flow_threshold) if row.cash_flow_threshold is not None else None,
        gross_yield_threshold=float(row.gross_yield_threshold) if row.gross_yield_threshold is not None else None,
        last_checked_at=row.last_checked_at,
        created_at=row.created_at,
    )


@router.post("/save", response_model=SavedSearchOut, status_code=201)
async def save_search(body: SavedSearchIn, user: CurrentUser, session: Session) -> SavedSearchOut:
    row = SavedSearch(
        user_id=user.id,
        name=body.name,
        filters=body.filters.model_dump(mode="json", exclude_defaults=True),
        overrides=body.defaults.model_dump(mode="json", exclude_none=True) if body.defaults else {},
        alerts_enabled=body.alerts_enabled,
        notify_new_listings=body.notify_new_listings,
        notify_price_reductions=body.notify_price_reductions,
        cash_flow_threshold=body.cash_flow_threshold,
        gross_yield_threshold=body.gross_yield_threshold,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return _out(row)


@router.get("/saved", response_model=list[SavedSearchOut])
async def list_saved(user: CurrentUser, session: Session) -> list[SavedSearchOut]:
    rows = (await session.execute(select(SavedSearch).where(SavedSearch.user_id == user.id).order_by(SavedSearch.created_at.desc()))).scalars()
    return [_out(row) for row in rows]


async def _owned(session: Session, user_id: uuid.UUID, search_id: uuid.UUID) -> SavedSearch:
    row = await session.get(SavedSearch, search_id)
    if row is None or row.user_id != user_id:
        raise NotFoundError("Saved search not found")
    return row


@router.patch("/saved/{search_id}", response_model=SavedSearchOut)
async def update_saved(search_id: uuid.UUID, body: SavedSearchPatch, user: CurrentUser, session: Session) -> SavedSearchOut:
    row = await _owned(session, user.id, search_id)
    for name, value in body.model_dump(exclude_unset=True).items():
        setattr(row, name, value)
    await session.flush()
    await session.refresh(row)
    return _out(row)


@router.delete("/saved/{search_id}", status_code=204)
async def delete_saved(search_id: uuid.UUID, user: CurrentUser, session: Session) -> None:
    await session.delete(await _owned(session, user.id, search_id))
