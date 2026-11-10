"""RentCast adapter: sale listings, long-term rent AVM, value AVM, market statistics, tax records.

API reference: https://developers.rentcast.io/reference
Authentication: ``X-Api-Key`` header. Listings are paginated with ``limit`` (max 500)
and ``offset``; we page until a short page is returned.

Notes on what RentCast does *not* provide: listing photos, marketing descriptions
and links to the originating listing site are not part of the sale-listing
payload, so those fields stay empty for RentCast-sourced listings.

Parsing is deliberately tolerant (every field optional) so a vendor-side schema
addition or omission degrades a field to "unavailable" instead of failing a search.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.core.config import Settings

from .base import (
    BedroomStat,
    Comparable,
    ListingPage,
    ListingQuery,
    ListingRecord,
    MarketHistoryPoint,
    MarketStats,
    PriceEvent,
    RentEstimateRecord,
    SubjectProperty,
    TaxRecord,
    ValueEstimateRecord,
)
from .http import ProviderHTTPClient

KEY = "rentcast"

_TYPE_FROM_RENTCAST = {
    "single family": "single_family",
    "condo": "condo",
    "townhouse": "townhouse",
    "manufactured": "manufactured",
    "multi-family": "multi_family",
    "multi family": "multi_family",
    "apartment": "apartment",
    "land": "land",
}
_TYPE_TO_RENTCAST = {
    "single_family": "Single Family",
    "condo": "Condo",
    "townhouse": "Townhouse",
    "manufactured": "Manufactured",
    "multi_family": "Multi-Family",
    "apartment": "Apartment",
    "land": "Land",
}


def _dec(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _int(value: Any) -> int | None:
    number = _dec(value)
    return int(number) if number is not None else None


def _datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _date(value: Any) -> date | None:
    parsed = _datetime(value)
    if parsed:
        return parsed.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _property_type(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return _TYPE_FROM_RENTCAST.get(value.strip().lower(), "other")


def parse_listing(item: dict[str, Any]) -> ListingRecord | None:
    listing_id = item.get("id")
    address = item.get("formattedAddress")
    if not listing_id or not address:
        return None

    raw_status = str(item.get("status") or "").lower()
    status = "active" if raw_status == "active" else "inactive" if raw_status == "inactive" else "unknown"

    history: list[PriceEvent] = []
    previous_price: Decimal | None = None
    raw_history = item.get("history") if isinstance(item.get("history"), dict) else {}
    for day in sorted(raw_history):
        entry = raw_history[day] or {}
        event_date = _date(entry.get("listedDate")) or _date(day)
        if event_date is None:
            continue
        price = _dec(entry.get("price"))
        event_type = "listed" if previous_price is None or price is None or price == previous_price else "price_change"
        history.append(PriceEvent(event_date=event_date, event_type=event_type, price=price))
        if price is not None:
            previous_price = price
        removed = _date(entry.get("removedDate"))
        if removed:
            history.append(PriceEvent(event_date=removed, event_type="removed", price=price))

    hoa = item.get("hoa") if isinstance(item.get("hoa"), dict) else {}
    agent = item.get("listingAgent") if isinstance(item.get("listingAgent"), dict) else {}
    office = item.get("listingOffice") if isinstance(item.get("listingOffice"), dict) else {}
    state = item.get("state")

    return ListingRecord(
        provider=KEY,
        provider_listing_id=str(listing_id),
        status=status,  # type: ignore[arg-type]
        listing_type=item.get("listingType"),
        formatted_address=address,
        address_line1=item.get("addressLine1"),
        address_line2=item.get("addressLine2"),
        city=item.get("city"),
        state=state.upper() if isinstance(state, str) and len(state) == 2 else None,
        zip_code=item.get("zipCode"),
        county=item.get("county"),
        latitude=item.get("latitude"),
        longitude=item.get("longitude"),
        property_type=_property_type(item.get("propertyType")),  # type: ignore[arg-type]
        bedrooms=_dec(item.get("bedrooms")),
        bathrooms=_dec(item.get("bathrooms")),
        square_feet=_int(item.get("squareFootage")),
        lot_size_sqft=_int(item.get("lotSize")),
        year_built=_int(item.get("yearBuilt")),
        price=_dec(item.get("price")),
        listed_date=_date(item.get("listedDate")),
        removed_date=_date(item.get("removedDate")),
        days_on_market=_int(item.get("daysOnMarket")),
        hoa_fee_monthly=_dec(hoa.get("fee")),
        mls_name=item.get("mlsName"),
        mls_number=item.get("mlsNumber"),
        agent_name=agent.get("name"),
        office_name=office.get("name"),
        last_seen_at=_datetime(item.get("lastSeenDate")),
        source_updated_at=_datetime(item.get("lastSeenDate")) or _datetime(item.get("createdDate")),
        price_history=history,
    )


def _comparable(item: dict[str, Any]) -> Comparable | None:
    address = item.get("formattedAddress")
    if not address:
        return None
    return Comparable(
        formatted_address=address,
        latitude=item.get("latitude"),
        longitude=item.get("longitude"),
        price=_dec(item.get("price")),
        bedrooms=_dec(item.get("bedrooms")),
        bathrooms=_dec(item.get("bathrooms")),
        square_feet=_int(item.get("squareFootage")),
        property_type=_property_type(item.get("propertyType")),  # type: ignore[arg-type]
        year_built=_int(item.get("yearBuilt")),
        distance_miles=_dec(item.get("distance")),
        days_old=_int(item.get("daysOld")),
        similarity=_dec(item.get("correlation")),
        listed_date=_date(item.get("listedDate")),
    )


def _bedroom_stats(rows: Any, *, rental: bool) -> list[BedroomStat]:
    out: list[BedroomStat] = []
    for row in rows if isinstance(rows, list) else []:
        beds = _int(row.get("bedrooms"))
        if beds is None:
            continue
        prefix = "Rent" if rental else "Price"
        out.append(
            BedroomStat(
                bedrooms=beds,
                median=_dec(row.get(f"median{prefix}")),
                average=_dec(row.get(f"average{prefix}")),
                low=_dec(row.get(f"min{prefix}")),
                high=_dec(row.get(f"max{prefix}")),
                count=_int(row.get("totalListings")) or 0,
                median_price_per_sqft=_dec(row.get(f"median{prefix}PerSquareFoot")),
                median_days_on_market=_dec(row.get("medianDaysOnMarket")),
            )
        )
    return sorted(out, key=lambda s: s.bedrooms)


def parse_market(zip_code: str, data: dict[str, Any]) -> MarketStats:
    rental = data.get("rentalData") if isinstance(data.get("rentalData"), dict) else {}
    sale = data.get("saleData") if isinstance(data.get("saleData"), dict) else {}

    months: dict[str, MarketHistoryPoint] = {}
    for month, row in (rental.get("history") or {}).items():
        months.setdefault(month, MarketHistoryPoint(month=month)).median_rent = _dec(row.get("medianRent"))
        months[month].rental_listings = _int(row.get("totalListings"))
    for month, row in (sale.get("history") or {}).items():
        months.setdefault(month, MarketHistoryPoint(month=month)).median_sale_price = _dec(row.get("medianPrice"))
        months[month].sale_listings = _int(row.get("totalListings"))

    return MarketStats(
        provider=KEY,
        zip_code=zip_code,
        median_rent=_dec(rental.get("medianRent")),
        average_rent=_dec(rental.get("averageRent")),
        rental_listings=_int(rental.get("totalListings")) or 0,
        median_rent_per_sqft=_dec(rental.get("medianRentPerSquareFoot")),
        rental_median_days_on_market=_dec(rental.get("medianDaysOnMarket")),
        rent_by_bedrooms=_bedroom_stats(rental.get("dataByBedrooms"), rental=True),
        median_sale_price=_dec(sale.get("medianPrice")),
        average_sale_price=_dec(sale.get("averagePrice")),
        sale_listings=_int(sale.get("totalListings")) or 0,
        median_price_per_sqft=_dec(sale.get("medianPricePerSquareFoot")),
        sale_median_days_on_market=_dec(sale.get("medianDaysOnMarket")),
        sale_by_bedrooms=_bedroom_stats(sale.get("dataByBedrooms"), rental=False),
        history=[months[m] for m in sorted(months)],
        fetched_at=datetime.now(UTC),
    )


class RentCastProvider:
    key = KEY
    name = "RentCast"
    attribution = "Listing and rent data provided by RentCast"

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        assert settings.rentcast_api_key is not None
        self._settings = settings
        self.page_size = max(1, min(settings.rentcast_page_size, 500))
        self._http = ProviderHTTPClient(
            KEY,
            settings.rentcast_base_url,
            headers={"X-Api-Key": settings.rentcast_api_key.get_secret_value(), "Accept": "application/json"},
            requests_per_second=settings.rentcast_requests_per_second,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------ listings

    def _listing_params(self, query: ListingQuery) -> dict[str, Any]:
        params: dict[str, Any] = {"status": "Active"}
        if query.latitude is not None and query.longitude is not None and query.radius_miles:
            params.update(latitude=query.latitude, longitude=query.longitude, radius=query.radius_miles)
        elif query.zip_code:
            params["zipCode"] = query.zip_code
        elif query.city:
            params["city"] = query.city
            params["state"] = query.state
        elif query.state:
            params["state"] = query.state
        if len(query.property_types) == 1 and query.property_types[0] in _TYPE_TO_RENTCAST:
            params["propertyType"] = _TYPE_TO_RENTCAST[query.property_types[0]]
        if query.min_beds is not None and query.min_beds == query.max_beds:
            params["bedrooms"] = query.min_beds
        if self._settings.rentcast_range_filters:
            if query.min_price is not None or query.max_price is not None:
                params["price"] = f"{query.min_price or ''}:{query.max_price or ''}"
            if query.min_beds != query.max_beds and (query.min_beds is not None or query.max_beds is not None):
                params["bedrooms"] = f"{query.min_beds if query.min_beds is not None else ''}:{query.max_beds if query.max_beds is not None else ''}"
            if query.max_days_on_market is not None:
                params["daysOld"] = f":{query.max_days_on_market}"
        return params

    async def search_listings(self, query: ListingQuery, *, offset: int, limit: int) -> ListingPage:
        limit = max(1, min(limit, self.page_size))
        params = {**self._listing_params(query), "limit": limit, "offset": offset}
        data = await self._http.get_json("/listings/sale", params=params, endpoint="listings/sale")
        rows = data if isinstance(data, list) else []
        listings = [record for record in (parse_listing(row) for row in rows if isinstance(row, dict)) if record]
        return ListingPage(listings=listings, has_more=len(rows) >= limit, next_offset=offset + len(rows))

    # ------------------------------------------------------------------ estimates

    @staticmethod
    def _subject_params(subject: SubjectProperty) -> dict[str, Any]:
        params: dict[str, Any] = {"address": subject.formatted_address}
        if subject.property_type in _TYPE_TO_RENTCAST:
            params["propertyType"] = _TYPE_TO_RENTCAST[subject.property_type]
        if subject.bedrooms is not None:
            params["bedrooms"] = str(subject.bedrooms.normalize())
        if subject.bathrooms is not None:
            params["bathrooms"] = str(subject.bathrooms.normalize())
        if subject.square_feet:
            params["squareFootage"] = subject.square_feet
        return params

    async def rent_estimate(self, subject: SubjectProperty) -> RentEstimateRecord | None:
        params = {**self._subject_params(subject), "compCount": 10}
        data = await self._http.get_json("/avm/rent/long-term", params=params, endpoint="avm/rent/long-term", not_found_ok=True)
        if not isinstance(data, dict):
            return None
        rent = _dec(data.get("rent"))
        if rent is None or rent <= 0:
            return None
        comps = [c for c in (_comparable(row) for row in data.get("comparables") or [] if isinstance(row, dict)) if c]
        return RentEstimateRecord(
            provider=KEY,
            level="property",
            rent=rent,
            rent_low=_dec(data.get("rentRangeLow")),
            rent_high=_dec(data.get("rentRangeHigh")),
            comparables=comps,
            fetched_at=datetime.now(UTC),
        )

    async def value_estimate(self, subject: SubjectProperty) -> ValueEstimateRecord | None:
        params = {**self._subject_params(subject), "compCount": 10}
        data = await self._http.get_json("/avm/value", params=params, endpoint="avm/value", not_found_ok=True)
        if not isinstance(data, dict):
            return None
        value = _dec(data.get("price"))
        if value is None or value <= 0:
            return None
        comps = [c for c in (_comparable(row) for row in data.get("comparables") or [] if isinstance(row, dict)) if c]
        return ValueEstimateRecord(
            provider=KEY,
            value=value,
            value_low=_dec(data.get("priceRangeLow")),
            value_high=_dec(data.get("priceRangeHigh")),
            comparables=comps,
            fetched_at=datetime.now(UTC),
        )

    async def tax_record(self, subject: SubjectProperty) -> TaxRecord | None:
        data = await self._http.get_json("/properties", params={"address": subject.formatted_address, "limit": 1}, endpoint="properties", not_found_ok=True)
        record = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else None
        taxes = record.get("propertyTaxes") if record else None
        if not isinstance(taxes, dict) or not taxes:
            return None
        latest_year = max(taxes, key=lambda y: _int(y) or 0)
        total = _dec((taxes[latest_year] or {}).get("total"))
        if total is None or total <= 0:
            return None
        return TaxRecord(provider=KEY, annual_amount=total, year=_int(latest_year) or 0, source="County tax record via RentCast")

    async def market_stats(self, zip_code: str) -> MarketStats | None:
        data = await self._http.get_json(
            "/markets", params={"zipCode": zip_code, "dataType": "All", "historyRange": 12}, endpoint="markets", not_found_ok=True
        )
        if not isinstance(data, dict):
            return None
        return parse_market(zip_code, data)
