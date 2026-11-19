"""Mapbox geocoding (server side): forward lookups resolve "near Atlanta" style radius and county
searches to coordinates and suggest cities and ZIP codes as the user types; reverse lookups find the
ZIP code under a point on the map.

Results come from Mapbox's temporary geocoding endpoint, whose terms do not allow
storing results, so they are used for the current search only and never persisted.
"""

from __future__ import annotations

import httpx

from app.core.config import Settings

from .base import GeocodeResult, PlaceSuggestion, ZipAtPoint
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

    async def zip_at(self, latitude: float, longitude: float) -> ZipAtPoint | None:
        params = {"longitude": f"{longitude:.5f}", "latitude": f"{latitude:.5f}", "types": "postcode", "country": "us", "limit": 1, "access_token": self._token}
        data = await self._http.get_json("/search/geocode/v6/reverse", params=params, endpoint="geocode/reverse")
        features = data.get("features") if isinstance(data, dict) else None
        if not features:
            return None
        properties = features[0].get("properties") or {}
        context = properties.get("context") or {}
        zip_code = str(properties.get("name") or (context.get("postcode") or {}).get("name") or "")[:5]
        if len(zip_code) != 5 or not zip_code.isdigit():
            return None
        city = (context.get("place") or {}).get("name") or (context.get("locality") or {}).get("name")
        state = (context.get("region") or {}).get("region_code")
        place = ", ".join(part for part in (city, state) if part) or None
        return ZipAtPoint(zip_code=zip_code, place=place)

    async def suggest(self, query: str, *, limit: int = 5) -> list[PlaceSuggestion]:
        params = {
            "q": query,
            "country": "us",
            "limit": limit,
            "types": "place,postcode",
            "autocomplete": "true",
            "access_token": self._token,
        }
        data = await self._http.get_json("/search/geocode/v6/forward", params=params, endpoint="geocode/suggest")
        features = data.get("features") if isinstance(data, dict) else None
        out: list[PlaceSuggestion] = []
        for feature in features or []:
            hit = _suggestion(feature)
            if hit and all(existing.label != hit.label for existing in out):
                out.append(hit)
        return out


def _suggestion(feature: dict) -> PlaceSuggestion | None:
    coordinates = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coordinates) < 2:
        return None
    properties = feature.get("properties") or {}
    context = properties.get("context") or {}
    kind = properties.get("feature_type")
    name = str(properties.get("name") or "").strip()
    region = (context.get("region") or {}).get("region_code")
    bbox = properties.get("bbox")
    common = {
        "latitude": float(coordinates[1]),
        "longitude": float(coordinates[0]),
        "region": region,
        "bbox": tuple(bbox) if isinstance(bbox, list) and len(bbox) == 4 else None,
    }
    if kind == "postcode":
        zip_code = name[:5]
        if len(zip_code) != 5 or not zip_code.isdigit():
            return None
        city = (context.get("place") or {}).get("name") or (context.get("locality") or {}).get("name")
        place = ", ".join(part for part in (city, region) if part)
        return PlaceSuggestion(kind="postcode", label=f"{zip_code} · {place}" if place else zip_code, name=zip_code, zip_code=zip_code, **common)
    if kind == "place" and name:
        return PlaceSuggestion(kind="place", label=f"{name}, {region}" if region else name, name=name, **common)
    return None
