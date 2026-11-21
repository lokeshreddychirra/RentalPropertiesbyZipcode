"""AirDNA adapter for short-term rental estimates ("Rentalizer").

AirDNA's API is available under an enterprise contract and its exact request /
response contract varies by agreement and API version. This adapter therefore:

* keeps the endpoint path configurable (``AIRDNA_BASE_URL``),
* isolates the vendor mapping in two small functions (``build_request`` and
  ``parse_estimate``) that you should confirm against the documentation supplied
  with your contract before going live,
* returns ``None`` (reported to the user as "STR estimate unavailable") whenever
  the response does not contain a usable ADR and occupancy — it never fills
  gaps with invented numbers.

AirDNA reports ADR inclusive of cleaning fees and occupancy as booked nights over
*available* nights; both facts are carried on the record so the financial engine
does not double-count cleaning income.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.core.config import Settings

from .base import StrEstimateRecord, SubjectProperty
from .http import ProviderHTTPClient

KEY = "airdna"
ESTIMATE_PATH = "/rentalizer/estimate"


def _dec(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _dig(data: Any, *paths: tuple[str, ...]) -> Any:
    """First non-null value found at any of the given key paths."""
    for path in paths:
        node = data
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        if node is not None:
            return node
    return None


def build_request(subject: SubjectProperty) -> dict[str, Any]:
    body: dict[str, Any] = {"address": subject.formatted_address}
    if subject.latitude is not None and subject.longitude is not None:
        body["location"] = {"lat": subject.latitude, "lng": subject.longitude}
    if subject.bedrooms is not None:
        body["bedrooms"] = int(subject.bedrooms)
        body["accommodates"] = max(int(subject.bedrooms) * 2, 2)
    if subject.bathrooms is not None:
        body["bathrooms"] = float(subject.bathrooms)
    return body


def parse_estimate(data: Any) -> StrEstimateRecord | None:
    payload = data.get("payload", data) if isinstance(data, dict) else None
    if not isinstance(payload, dict):
        return None
    summary = _dig(payload, ("stats", "future", "summary"), ("stats", "summary"), ("property_statistics",), ("summary",)) or payload

    adr = _dec(_dig(summary, ("adr",), ("adr", "ltm"), ("average_daily_rate",)))
    occupancy = _dec(_dig(summary, ("occupancy",), ("occupancy", "ltm"), ("occupancy_rate",)))
    revenue = _dec(_dig(summary, ("revenue",), ("revenue", "ltm"), ("annual_revenue",)))
    if adr is None or occupancy is None or adr <= 0 or occupancy <= 0:
        return None
    if occupancy <= 1:  # reported as a fraction
        occupancy *= 100
    if occupancy > 100:
        return None

    seasonality: list[Decimal] | None = None
    monthly = _dig(payload, ("stats", "future", "monthly"), ("monthly",))
    if isinstance(monthly, list) and len(monthly) == 12:
        values = [_dec(_dig(m, ("revenue",), ("occupancy",))) for m in monthly]
        if all(v is not None and v >= 0 for v in values) and sum(values) > 0:  # type: ignore[arg-type]
            average = sum(values) / 12  # type: ignore[arg-type]
            seasonality = [(v / average).quantize(Decimal("0.001")) for v in values]  # type: ignore[operator]

    comps = _dig(payload, ("comps",), ("comparables",))
    return StrEstimateRecord(
        provider=KEY,
        level="property",
        adr=adr.quantize(Decimal("0.01")),
        occupancy_pct=occupancy.quantize(Decimal("0.01")),
        occupancy_basis="available",
        annual_revenue=revenue.quantize(Decimal("0.01")) if revenue is not None else None,
        cleaning_fee=_dec(_dig(summary, ("cleaning_fee",))),
        adr_includes_cleaning_fee=True,
        seasonality=seasonality,
        comp_count=len(comps) if isinstance(comps, list) else 0,
        fetched_at=datetime.now(UTC),
    )


class AirDNAProvider:
    key = KEY
    name = "AirDNA"

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        assert settings.airdna_api_key is not None
        self._http = ProviderHTTPClient(
            KEY,
            settings.airdna_base_url,
            headers={"Authorization": f"Bearer {settings.airdna_api_key.get_secret_value()}", "Accept": "application/json"},
            requests_per_second=settings.airdna_requests_per_second,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def str_estimate(self, subject: SubjectProperty) -> StrEstimateRecord | None:
        response = await self._http.request("POST", ESTIMATE_PATH, json=build_request(subject), endpoint="rentalizer/estimate", not_found_ok=True)
        if response is None:
            return None
        return parse_estimate(response.json())
