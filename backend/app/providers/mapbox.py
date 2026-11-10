"""Mapbox forward geocoding (server side), used to resolve "near Atlanta" style
radius and county searches to coordinates.

Results come from Mapbox's temporary geocoding endpoint, whose terms do not allow
storing results, so they are used for the current search only and never persisted.
"""

from __future__ import annotations

import httpx

from app.core.config import Settings

from .base import GeocodeResult
from .http import ProviderHTTPClient

KEY = "mapbox"


class MapboxGeocoder:
    key = KEY

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        assert settings.mapbox_access_token is not None
        self._token = settings.mapbox_access_token.get_secret_value()
        self._http = ProviderHTTPClient(KEY, "https://api.mapbox.com", requests_per_second=10, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def geocode(self, query: str, *, kinds: tuple[str, ...] = ()) -> GeocodeResult | None:
        params = {
            "q": query,
            "country": "us",
            "limit": 1,
            "types": ",".join(kinds) if kinds else "place,postcode,district,region,locality",
            "access_token": self._token,
        }
        data = await self._http.get_json("/search/geocode/v6/forward", params=params, endpoint="geocode/forward")
        features = data.get("features") if isinstance(data, dict) else None
        if not features:
            return None
        feature = features[0]
        coordinates = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coordinates) < 2:
            return None
        properties = feature.get("properties") or {}
        bbox = properties.get("bbox")
        return GeocodeResult(
            name=properties.get("full_address") or properties.get("name") or query,
            longitude=float(coordinates[0]),
            latitude=float(coordinates[1]),
            bbox=tuple(bbox) if isinstance(bbox, list) and len(bbox) == 4 else None,  # type: ignore[arg-type]
            kind=properties.get("feature_type"),
        )
