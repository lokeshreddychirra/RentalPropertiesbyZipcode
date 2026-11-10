"""Persistence for listings and estimates, and loading of analysis contexts."""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.tables import (
    Property,
    PropertyExpense,
    PropertyImage,
    PropertyListing,
    PropertyListingSource,
    PropertyPriceHistory,
    RentalComparable,
    RentEstimate,
    SaleComparable,
    ShortTermRentalEstimate,
    StrRegulation,
    ValueEstimate,
)
from app.providers.base import (
    Comparable,
    RentEstimateRecord,
    StrEstimateRecord,
    SubjectProperty,
    TaxRecord,
    ValueEstimateRecord,
)
from app.providers.demo import demo_legality
from app.providers.usage import PROVIDER_SPECS
from app.schemas.analysis import LegalityInfo, PriceReduction, PropertyContext, RentInfo, StrInfo

from .dedupe import MergedListing

CHUNK = 500

LEGALITY_LABELS = {
    "permitted": "Permitted",
    "restricted": "Restricted",
    "prohibited": "Prohibited",
    "unknown": "Unknown / needs verification",
}


def _chunks(items: Sequence[Any], size: int = CHUNK) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def provider_name(key: str | None) -> str | None:
    if key is None:
        return None
    spec = PROVIDER_SPECS.get(key)
    return spec.name if spec else key


# --------------------------------------------------------------------------- upsert


async def upsert_listings(session: AsyncSession, merged: list[MergedListing]) -> None:
    """Insert or update properties, their canonical listing, sources, images and price history."""
    now = datetime.now(UTC)
    for chunk in _chunks(merged):
        property_rows = []
        for item in chunk:
            p = item.primary
            location = f"SRID=4326;POINT({p.longitude} {p.latitude})" if p.latitude is not None and p.longitude is not None else None
            property_rows.append(
                dict(
                    id=item.property_id,
                    dedupe_key=item.key[:255],
                    formatted_address=p.formatted_address[:300],
                    address_line1=p.address_line1,
                    address_line2=p.address_line2,
                    city=p.city,
                    state=p.state,
                    zip_code=(p.zip_code or "")[:10] or None,
                    county=p.county,
                    latitude=p.latitude,
                    longitude=p.longitude,
                    location=location,
                    property_type=p.property_type,
                    bedrooms=p.bedrooms,
                    bathrooms=p.bathrooms,
                    square_feet=p.square_feet,
                    lot_size_sqft=p.lot_size_sqft,
                    year_built=p.year_built,
                    is_demo=p.is_demo,
                )
            )
        stmt = insert(Property).values(property_rows)
        update_cols = {c: getattr(stmt.excluded, c) for c in property_rows[0] if c not in ("id", "dedupe_key")}
        update_cols["updated_at"] = func.now()
        await session.execute(stmt.on_conflict_do_update(index_elements=[Property.id], set_=update_cols))

        listing_rows = []
        for item in chunk:
            p = item.primary
            listing_rows.append(
                dict(
                    id=uuid.uuid4(),
                    property_id=item.property_id,
                    status=p.status,
                    listing_type=p.listing_type,
                    price=p.price,
                    listed_date=p.listed_date,
                    removed_date=p.removed_date,
                    days_on_market=p.days_on_market,
                    hoa_fee_monthly=p.hoa_fee_monthly,
                    description=p.description,
                    listing_url=p.listing_url,
                    mls_name=p.mls_name,
                    mls_number=p.mls_number,
                    agent_name=p.agent_name,
                    office_name=p.office_name,
                    primary_provider=p.provider,
                    last_seen_at=p.last_seen_at,
                    source_updated_at=p.source_updated_at,
                )
            )
        stmt = insert(PropertyListing).values(listing_rows)
        update_cols = {c: getattr(stmt.excluded, c) for c in listing_rows[0] if c not in ("id", "property_id")}
        update_cols["updated_at"] = func.now()
        result = await session.execute(
            stmt.on_conflict_do_update(index_elements=[PropertyListing.property_id], set_=update_cols).returning(
                PropertyListing.property_id, PropertyListing.id
            )
        )
        listing_ids = dict(result.all())

        source_rows, image_rows, history_rows, expense_rows = [], [], [], []
        for item in chunk:
            for source in item.sources:
                source_rows.append(
                    dict(
                        id=uuid.uuid4(),
                        listing_id=listing_ids[item.property_id],
                        provider_key=source.provider,
                        provider_listing_id=source.provider_listing_id[:255],
                        price=source.price,
                        status=source.status,
                        source_url=source.listing_url,
                        fetched_at=now,
                    )
                )
            for position, url in enumerate(item.image_urls[:40]):
                image_rows.append(
                    dict(id=uuid.uuid4(), property_id=item.property_id, url=url[:1000], position=position, provider_key=item.primary.provider, attribution=item.primary.image_attribution)
                )
            for event in item.price_history:
                history_rows.append(
                    dict(id=uuid.uuid4(), property_id=item.property_id, event_date=event.event_date, event_type=event.event_type, price=event.price, provider_key=item.primary.provider)
                )
            p = item.primary
            if p.property_tax_annual is not None:
                expense_rows.append(
                    dict(
                        id=uuid.uuid4(),
                        property_id=item.property_id,
                        kind="property_tax",
                        annual_amount=p.property_tax_annual,
                        year=p.property_tax_year or 0,
                        source="Listing",
                        provider_key=p.provider,
                    )
                )

        if source_rows:
            stmt = insert(PropertyListingSource).values(source_rows)
            await session.execute(
                stmt.on_conflict_do_update(
                    index_elements=["provider_key", "provider_listing_id"],
                    set_=dict(listing_id=stmt.excluded.listing_id, price=stmt.excluded.price, status=stmt.excluded.status, source_url=stmt.excluded.source_url, fetched_at=stmt.excluded.fetched_at),
                )
            )
        if image_rows:
            await session.execute(insert(PropertyImage).values(image_rows).on_conflict_do_nothing())
        if history_rows:
            await session.execute(insert(PropertyPriceHistory).values(history_rows).on_conflict_do_nothing())
        if expense_rows:
            stmt = insert(PropertyExpense).values(expense_rows)
            await session.execute(
                stmt.on_conflict_do_update(index_elements=["property_id", "kind", "year"], set_=dict(annual_amount=stmt.excluded.annual_amount, source=stmt.excluded.source))
            )


def _comparable_row(comp: Comparable, *, rental: bool) -> dict[str, Any]:
    row: dict[str, Any] = dict(
        id=uuid.uuid4(),
        formatted_address=comp.formatted_address[:300],
        latitude=comp.latitude,
        longitude=comp.longitude,
        bedrooms=comp.bedrooms,
        bathrooms=comp.bathrooms,
        square_feet=comp.square_feet,
        property_type=comp.property_type,
        distance_miles=comp.distance_miles,
        days_old=comp.days_old,
        similarity=comp.similarity,
        listed_date=comp.listed_date,
    )
    if rental:
        row["rent"] = comp.price
    else:
        row["price"] = comp.price
        row["year_built"] = comp.year_built
    return row


async def save_rent_estimate(session: AsyncSession, property_id: uuid.UUID, record: RentEstimateRecord) -> None:
    stmt = insert(RentEstimate).values(
        id=uuid.uuid4(),
        property_id=property_id,
        provider_key=record.provider,
        level=record.level,
        rent=record.rent,
        rent_low=record.rent_low,
        rent_high=record.rent_high,
        comp_count=len(record.comparables),
        market_sample=record.market_sample,
        fetched_at=record.fetched_at,
    )
    result = await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["property_id", "provider_key", "level"],
            set_=dict(rent=stmt.excluded.rent, rent_low=stmt.excluded.rent_low, rent_high=stmt.excluded.rent_high, comp_count=stmt.excluded.comp_count, market_sample=stmt.excluded.market_sample, fetched_at=stmt.excluded.fetched_at),
        ).returning(RentEstimate.id)
    )
    estimate_id = result.scalar_one()
    if record.level == "property":
        await session.execute(delete(RentalComparable).where(RentalComparable.rent_estimate_id == estimate_id))
        rows = [{**_comparable_row(c, rental=True), "rent_estimate_id": estimate_id} for c in record.comparables]
        if rows:
            await session.execute(insert(RentalComparable).values(rows))


async def save_market_rent_estimates(session: AsyncSession, rows: list[tuple[uuid.UUID, RentEstimateRecord]]) -> None:
    for chunk in _chunks(rows):
        values = [
            dict(id=uuid.uuid4(), property_id=pid, provider_key=r.provider, level=r.level, rent=r.rent, rent_low=r.rent_low, rent_high=r.rent_high, comp_count=0, market_sample=r.market_sample, fetched_at=r.fetched_at)
            for pid, r in chunk
        ]
        stmt = insert(RentEstimate).values(values)
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=["property_id", "provider_key", "level"],
                set_=dict(rent=stmt.excluded.rent, rent_low=stmt.excluded.rent_low, rent_high=stmt.excluded.rent_high, market_sample=stmt.excluded.market_sample, fetched_at=stmt.excluded.fetched_at),
            )
        )


async def save_value_estimate(session: AsyncSession, property_id: uuid.UUID, record: ValueEstimateRecord) -> None:
    stmt = insert(ValueEstimate).values(
        id=uuid.uuid4(), property_id=property_id, provider_key=record.provider, value=record.value, value_low=record.value_low, value_high=record.value_high, comp_count=len(record.comparables), fetched_at=record.fetched_at
    )
    result = await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["property_id", "provider_key"],
            set_=dict(value=stmt.excluded.value, value_low=stmt.excluded.value_low, value_high=stmt.excluded.value_high, comp_count=stmt.excluded.comp_count, fetched_at=stmt.excluded.fetched_at),
        ).returning(ValueEstimate.id)
    )
    estimate_id = result.scalar_one()
    await session.execute(delete(SaleComparable).where(SaleComparable.value_estimate_id == estimate_id))
    rows = [{**_comparable_row(c, rental=False), "value_estimate_id": estimate_id} for c in record.comparables]
    if rows:
        await session.execute(insert(SaleComparable).values(rows))


async def save_str_estimate(session: AsyncSession, property_id: uuid.UUID, record: StrEstimateRecord) -> None:
    values = dict(
        level=record.level,
        adr=record.adr,
        occupancy_pct=record.occupancy_pct,
        occupancy_basis=record.occupancy_basis,
        annual_revenue=record.annual_revenue,
        cleaning_fee=record.cleaning_fee,
        adr_includes_cleaning_fee=record.adr_includes_cleaning_fee,
        avg_stay_nights=record.avg_stay_nights,
        seasonality=[str(w) for w in record.seasonality] if record.seasonality else None,
        comp_count=record.comp_count,
        fetched_at=record.fetched_at,
    )
    stmt = insert(ShortTermRentalEstimate).values(id=uuid.uuid4(), property_id=property_id, provider_key=record.provider, **values)
    await session.execute(stmt.on_conflict_do_update(index_elements=["property_id", "provider_key"], set_=values))


async def save_tax_record(session: AsyncSession, property_id: uuid.UUID, record: TaxRecord) -> None:
    stmt = insert(PropertyExpense).values(
        id=uuid.uuid4(), property_id=property_id, kind="property_tax", annual_amount=record.annual_amount, year=record.year, source=record.source[:60], provider_key=record.provider
    )
    await session.execute(
        stmt.on_conflict_do_update(index_elements=["property_id", "kind", "year"], set_=dict(annual_amount=stmt.excluded.annual_amount, source=stmt.excluded.source))
    )


# --------------------------------------------------------------------------- legality


class LegalityResolver:
    """Looks up verified STR rules, most specific jurisdiction first."""

    def __init__(self, rows: Sequence[StrRegulation]):
        self._rows = {(r.jurisdiction_type, r.jurisdiction_key): r for r in rows}

    @classmethod
    async def load(cls, session: AsyncSession) -> LegalityResolver:
        return cls((await session.execute(select(StrRegulation))).scalars().all())

    def resolve(self, *, zip_code: str | None, city: str | None, county: str | None, state: str | None, is_demo: bool) -> LegalityInfo:
        if is_demo:
            demo = demo_legality(zip_code)
            if demo and demo[0] != "unknown":
                return LegalityInfo(status=demo[0], verified=True, label=LEGALITY_LABELS[demo[0]], summary=demo[1], jurisdiction=f"ZIP {zip_code} (demo)")  # type: ignore[arg-type]
            return LegalityInfo()
        st = (state or "").lower()
        candidates = [
            ("zip", (zip_code or "")[:5]),
            ("city", f"{(city or '').strip().lower()},{st}"),
            ("county", f"{(county or '').strip().lower().removesuffix(' county')},{st}"),
            ("state", st),
        ]
        for kind, key in candidates:
            row = self._rows.get((kind, key))
            if row is not None:
                return LegalityInfo(
                    status=row.status,  # type: ignore[arg-type]
                    verified=True,
                    label=LEGALITY_LABELS.get(row.status, row.status),
                    summary=row.summary,
                    source_url=row.source_url,
                    verified_at=row.verified_at,
                    max_nights_per_year=row.max_nights_per_year,
                    jurisdiction=f"{kind}: {row.jurisdiction_key}",
                )
        return LegalityInfo()


def normalize_jurisdiction(kind: str, key: str) -> str:
    key = key.strip().lower()
    if kind == "zip":
        return key[:5]
    if kind in ("city", "county"):
        parts = [p.strip() for p in key.split(",")]
        name = parts[0].removesuffix(" county") if kind == "county" else parts[0]
        return f"{name},{parts[1] if len(parts) > 1 else ''}"
    return key


# --------------------------------------------------------------------------- contexts


def _price_reduction(events: list[PropertyPriceHistory]) -> PriceReduction | None:
    priced = [e for e in sorted(events, key=lambda e: e.event_date) if e.price is not None and e.event_type in ("listed", "price_change")]
    if len(priced) < 2:
        return None
    previous, current = priced[-2], priced[-1]
    if current.price >= previous.price or previous.price <= 0:  # type: ignore[operator]
        return None
    percent = ((previous.price - current.price) / previous.price * 100).quantize(Decimal("0.1"))  # type: ignore[operator]
    return PriceReduction(previous_price=previous.price, current_price=current.price, changed_on=current.event_date, percent=percent)  # type: ignore[arg-type]


async def load_contexts(session: AsyncSession, property_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, PropertyContext]:
    """Bulk-load analysis contexts. Estimates older than their freshness threshold are ignored."""
    settings = get_settings()
    now = datetime.now(UTC)
    rent_cutoff = now - timedelta(days=settings.rent_estimate_ttl_days)
    market_cutoff = now - timedelta(days=settings.market_stats_ttl_days)
    str_cutoff = now - timedelta(days=settings.str_estimate_ttl_days)
    value_cutoff = now - timedelta(days=settings.value_estimate_ttl_days)
    resolver = await LegalityResolver.load(session)
    out: dict[uuid.UUID, PropertyContext] = {}

    for chunk in _chunks(list(property_ids), 1000):
        rows = (
            await session.execute(select(Property, PropertyListing).outerjoin(PropertyListing, PropertyListing.property_id == Property.id).where(Property.id.in_(chunk)))
        ).all()

        rents: dict[uuid.UUID, dict[str, RentEstimate]] = defaultdict(dict)
        for estimate in (await session.execute(select(RentEstimate).where(RentEstimate.property_id.in_(chunk)))).scalars():
            cutoff = rent_cutoff if estimate.level == "property" else market_cutoff
            if estimate.fetched_at >= cutoff:
                existing = rents[estimate.property_id].get(estimate.level)
                if existing is None or estimate.fetched_at > existing.fetched_at:
                    rents[estimate.property_id][estimate.level] = estimate

        strs: dict[uuid.UUID, ShortTermRentalEstimate] = {}
        for estimate in (await session.execute(select(ShortTermRentalEstimate).where(ShortTermRentalEstimate.property_id.in_(chunk), ShortTermRentalEstimate.fetched_at >= str_cutoff))).scalars():
            existing = strs.get(estimate.property_id)
            if existing is None or estimate.fetched_at > existing.fetched_at:
                strs[estimate.property_id] = estimate

        values: dict[uuid.UUID, Decimal] = {}
        for pid, value in (await session.execute(select(ValueEstimate.property_id, ValueEstimate.value).where(ValueEstimate.property_id.in_(chunk), ValueEstimate.fetched_at >= value_cutoff))).all():
            values[pid] = value

        taxes: dict[uuid.UUID, PropertyExpense] = {}
        for expense in (await session.execute(select(PropertyExpense).where(PropertyExpense.property_id.in_(chunk), PropertyExpense.kind == "property_tax"))).scalars():
            existing_tax = taxes.get(expense.property_id)
            if existing_tax is None or expense.year > existing_tax.year:
                taxes[expense.property_id] = expense

        history: dict[uuid.UUID, list[PropertyPriceHistory]] = defaultdict(list)
        for event in (await session.execute(select(PropertyPriceHistory).where(PropertyPriceHistory.property_id.in_(chunk)))).scalars():
            history[event.property_id].append(event)

        images: dict[uuid.UUID, tuple[str, int]] = {}
        for pid, url, count in (
            await session.execute(
                select(PropertyImage.property_id, func.min(PropertyImage.url).filter(PropertyImage.position == 0), func.count()).where(PropertyImage.property_id.in_(chunk)).group_by(PropertyImage.property_id)
            )
        ).all():
            images[pid] = (url, count)

        sources: dict[uuid.UUID, list[str]] = defaultdict(list)
        listing_ids = {listing.id: prop.id for prop, listing in rows if listing is not None}
        if listing_ids:
            for listing_id, provider_key in (
                await session.execute(select(PropertyListingSource.listing_id, PropertyListingSource.provider_key).where(PropertyListingSource.listing_id.in_(list(listing_ids))))
            ).all():
                name = provider_name(provider_key) or provider_key
                if name not in sources[listing_ids[listing_id]]:
                    sources[listing_ids[listing_id]].append(name)

        for prop, listing in rows:
            rent_info = None
            by_level = rents.get(prop.id, {})
            estimate = by_level.get("property") or by_level.get("market_zip")
            if estimate is not None:
                rent_info = RentInfo(
                    rent=estimate.rent,
                    rent_low=estimate.rent_low,
                    rent_high=estimate.rent_high,
                    source="property_avm" if estimate.level == "property" else "market_zip",
                    provider=provider_name(estimate.provider_key) or estimate.provider_key,
                    comp_count=estimate.comp_count,
                    market_sample=estimate.market_sample,
                    fetched_at=estimate.fetched_at,
                )
            str_info = None
            st = strs.get(prop.id)
            if st is not None:
                str_info = StrInfo(
                    adr=st.adr,
                    occupancy_pct=st.occupancy_pct,
                    occupancy_basis=st.occupancy_basis,  # type: ignore[arg-type]
                    annual_revenue=st.annual_revenue,
                    cleaning_fee=st.cleaning_fee,
                    adr_includes_cleaning_fee=st.adr_includes_cleaning_fee,
                    avg_stay_nights=st.avg_stay_nights,
                    seasonality=[Decimal(str(w)) for w in st.seasonality] if st.seasonality else None,
                    level=st.level,  # type: ignore[arg-type]
                    provider=provider_name(st.provider_key) or st.provider_key,
                    comp_count=st.comp_count,
                    fetched_at=st.fetched_at,
                )
            tax = taxes.get(prop.id)
            image = images.get(prop.id)
            out[prop.id] = PropertyContext(
                id=prop.id,
                formatted_address=prop.formatted_address,
                address_line1=prop.address_line1,
                city=prop.city,
                state=prop.state,
                zip_code=prop.zip_code,
                county=prop.county,
                latitude=float(prop.latitude) if prop.latitude is not None else None,
                longitude=float(prop.longitude) if prop.longitude is not None else None,
                property_type=prop.property_type,
                bedrooms=prop.bedrooms,
                bathrooms=prop.bathrooms,
                square_feet=prop.square_feet,
                year_built=prop.year_built,
                price=listing.price if listing else None,
                status=listing.status if listing else "unknown",
                days_on_market=listing.days_on_market if listing else None,
                listed_date=listing.listed_date if listing else None,
                hoa_fee_monthly=listing.hoa_fee_monthly if listing else None,
                property_tax_annual=tax.annual_amount if tax else None,
                property_tax_source=f"{tax.source}{f' ({tax.year})' if tax.year else ''}" if tax else None,
                listing_url=listing.listing_url if listing else None,
                image_url=image[0] if image else None,
                image_count=image[1] if image else 0,
                listing_source=provider_name(listing.primary_provider) if listing else None,
                listing_sources=sources.get(prop.id, []),
                last_seen_at=listing.last_seen_at if listing else None,
                is_demo=prop.is_demo,
                price_reduction=_price_reduction(history.get(prop.id, [])),
                value_estimate=values.get(prop.id),
                rent=rent_info,
                short_term=str_info,
                legality=resolver.resolve(zip_code=prop.zip_code, city=prop.city, county=prop.county, state=prop.state, is_demo=prop.is_demo),
            )
    return out


async def load_context(session: AsyncSession, property_id: uuid.UUID) -> PropertyContext | None:
    return (await load_contexts(session, [property_id])).get(property_id)


def subject_for(ctx: PropertyContext) -> SubjectProperty:
    return SubjectProperty(
        formatted_address=ctx.formatted_address,
        latitude=ctx.latitude,
        longitude=ctx.longitude,
        zip_code=ctx.zip_code,
        city=ctx.city,
        state=ctx.state,
        property_type=ctx.property_type,
        bedrooms=ctx.bedrooms,
        bathrooms=ctx.bathrooms,
        square_feet=ctx.square_feet,
        price=ctx.price,
        seed=str(ctx.id),
    )
