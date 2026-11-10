"""Listing deduplication across providers.

Two provider records describe the same home when their normalised street
address, unit and 5-digit ZIP match. The normalised key also yields a stable
property id (UUIDv5), so re-fetching a listing always updates the same row.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

from app.providers.base import ListingRecord, PriceEvent

_NAMESPACE = uuid.UUID("6f1d1c0e-5d0b-4f38-9d0a-6c5a2b7f3e11")

_ABBREVIATIONS = {
    "street": "st", "avenue": "ave", "av": "ave", "drive": "dr", "road": "rd", "lane": "ln", "court": "ct",
    "boulevard": "blvd", "place": "pl", "terrace": "ter", "circle": "cir", "highway": "hwy", "parkway": "pkwy",
    "trail": "trl", "square": "sq", "north": "n", "south": "s", "east": "e", "west": "w", "northeast": "ne",
    "northwest": "nw", "southeast": "se", "southwest": "sw", "apartment": "unit", "apt": "unit", "suite": "unit",
    "ste": "unit", "number": "unit", "no": "unit",
}
_UNIT_RE = re.compile(r"\b(?:unit|apt|apartment|suite|ste|#)\s*([a-z0-9-]+)\s*$")


def _tokens(text: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9#\s-]", " ", text.lower())
    return [_ABBREVIATIONS.get(token, token) for token in cleaned.split()]


def dedupe_key(record: ListingRecord) -> str:
    zip5 = (record.zip_code or "")[:5]
    line1 = record.address_line1 or record.formatted_address.split(",")[0]
    unit = record.address_line2 or ""
    lowered = line1.lower().strip()
    match = _UNIT_RE.search(lowered)
    if match and not unit:
        unit = match.group(1)
        lowered = lowered[: match.start()]
    street = " ".join(_tokens(lowered))
    unit_tokens = [t for t in _tokens(unit) if t not in ("unit", "#")]
    unit_norm = "".join(unit_tokens).lstrip("#")
    if street and zip5:
        return f"{street}|{unit_norm}|{zip5}"
    return "addr:" + " ".join(_tokens(record.formatted_address))


def property_id_for(key: str) -> uuid.UUID:
    return uuid.uuid5(_NAMESPACE, key)


@dataclass
class MergedListing:
    """One home, possibly backed by several provider records."""

    property_id: uuid.UUID
    key: str
    primary: ListingRecord
    sources: list[ListingRecord] = field(default_factory=list)
    image_urls: list[str] = field(default_factory=list)
    price_history: list[PriceEvent] = field(default_factory=list)


_FILLABLE = (
    "address_line1", "address_line2", "city", "state", "zip_code", "county", "latitude", "longitude", "property_type",
    "bedrooms", "bathrooms", "square_feet", "lot_size_sqft", "year_built", "price", "listed_date", "days_on_market",
    "hoa_fee_monthly", "property_tax_annual", "property_tax_year", "description", "listing_url", "mls_name",
    "mls_number", "agent_name", "office_name", "listing_type",
)


def _rank(record: ListingRecord) -> tuple[int, float]:
    seen = record.last_seen_at.timestamp() if record.last_seen_at else 0.0
    return (1 if record.status == "active" else 0, seen)


def merge_listings(records: list[ListingRecord]) -> list[MergedListing]:
    groups: dict[str, list[ListingRecord]] = {}
    for record in records:
        groups.setdefault(dedupe_key(record), []).append(record)

    merged: list[MergedListing] = []
    for key, group in groups.items():
        # One record per provider listing id; the freshest active record leads.
        unique = {(r.provider, r.provider_listing_id): r for r in group}
        ordered = sorted(unique.values(), key=_rank, reverse=True)
        primary = ordered[0].model_copy(deep=True)
        for other in ordered[1:]:
            for name in _FILLABLE:
                if getattr(primary, name) is None and getattr(other, name) is not None:
                    setattr(primary, name, getattr(other, name))
        images: list[str] = []
        events: dict[tuple, PriceEvent] = {}
        for record in ordered:
            for url in record.image_urls:
                if url not in images:
                    images.append(url)
            for event in record.price_history:
                events.setdefault((event.event_date, event.event_type, event.price), event)
        merged.append(
            MergedListing(
                property_id=property_id_for(key),
                key=key,
                primary=primary,
                sources=ordered,
                image_urls=images,
                price_history=sorted(events.values(), key=lambda e: e.event_date),
            )
        )
    return merged
