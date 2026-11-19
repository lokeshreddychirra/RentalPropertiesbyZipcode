"""ZIP codes covered by a shape drawn on the map, or by a city typed in the search box.

Searches are bought per ZIP code, so a drawn area or a city is turned into the ZIP codes it covers: a
small grid of points is reverse-geocoded (geocoder only, no listing requests) and the distinct
postcodes are collected. Areas that are too wide, or that cover more than ``AREA_MAX_ZIPS`` ZIP codes,
are refused with a request to zoom in and draw a smaller area. Cities with more ZIP codes than that
are listed so the user can pick which ones to search.
"""

from __future__ import annotations

import asyncio
import math
from collections import Counter
from dataclasses import dataclass, field

from app.providers.base import BudgetExceeded, Geocoder, ProviderError, ZipAtPoint

from .plans import AREA_MAX_ZIPS
from .search import miles_between, point_in_polygon

# Wider than this (in either direction) is refused before any lookup: it would cover far more than
# AREA_MAX_ZIPS ZIP codes almost anywhere.
AREA_MAX_SPAN_MILES = 30.0
# Grid density: at most GRID x GRID sample points, never closer than MIN_SPACING_MILES apart.
GRID = 5
MIN_SPACING_MILES = 0.6
LOOKUP_CONCURRENCY = 6
# Cities: a denser grid over the city's bounding box (capped at PLACE_MAX_SPAN_MILES around its centre).
PLACE_GRID = 7
PLACE_MAX_SPAN_MILES = 40.0
PLACE_MAX_LISTED = 40


@dataclass
class AreaZips:
    zip_codes: list[str] = field(default_factory=list)
    too_large: bool = False
    span_miles: float = 0.0
    lookup_failed: bool = False


def span_miles(polygon: list[tuple[float, float]]) -> tuple[float, float]:
    """Width and height (miles) of the shape's bounding box."""
    lngs = [p[0] for p in polygon]
    lats = [p[1] for p in polygon]
    mid_lat = (min(lats) + max(lats)) / 2
    mid_lng = (min(lngs) + max(lngs)) / 2
    return miles_between(mid_lat, min(lngs), mid_lat, max(lngs)), miles_between(min(lats), mid_lng, max(lats), mid_lng)


def sample_points(polygon: list[tuple[float, float]], grid: int = GRID) -> list[tuple[float, float]]:
    """Grid points (lng, lat) inside the shape: cell centres of an up-to grid x grid grid over its bounding box."""
    lngs = [p[0] for p in polygon]
    lats = [p[1] for p in polygon]
    west, east, south, north = min(lngs), max(lngs), min(lats), max(lats)
    width, height = span_miles(polygon)
    spacing = max(MIN_SPACING_MILES, max(width, height) / grid)
    nx = max(1, min(grid, math.ceil(width / spacing)))
    ny = max(1, min(grid, math.ceil(height / spacing)))
    points = []
    for i in range(nx):
        for j in range(ny):
            lng = west + (east - west) * (i + 0.5) / nx
            lat = south + (north - south) * (j + 0.5) / ny
            if point_in_polygon(lng, lat, polygon):
                points.append((lng, lat))
    if not points:  # a thin or tiny shape: fall back to its average vertex
        points.append((sum(lngs) / len(lngs), sum(lats) / len(lats)))
    return points


async def _lookup_all(geocoder: Geocoder, points: list[tuple[float, float]]) -> tuple[list[ZipAtPoint | None], int]:
    """Reverse-geocode every (lng, lat) point; returns the hits and how many lookups failed."""
    semaphore = asyncio.Semaphore(LOOKUP_CONCURRENCY)
    failures = 0

    async def lookup(lng: float, lat: float) -> ZipAtPoint | None:
        nonlocal failures
        async with semaphore:
            try:
                return await geocoder.zip_at(round(lat, 4), round(lng, 4))
            except (ProviderError, BudgetExceeded):
                failures += 1
                return None

    hits = await asyncio.gather(*(lookup(lng, lat) for lng, lat in points))
    return list(hits), failures


async def zips_in_area(geocoder: Geocoder, polygon: list[tuple[float, float]]) -> AreaZips:
    width, height = span_miles(polygon)
    span = round(max(width, height), 1)
    if span > AREA_MAX_SPAN_MILES:
        return AreaZips(too_large=True, span_miles=span)

    hits, failures = await _lookup_all(geocoder, sample_points(polygon))
    counts = Counter(hit.zip_code for hit in hits if hit)
    # Most-covered ZIP codes first.
    zips = [z for z, _ in counts.most_common()]
    return AreaZips(
        zip_codes=zips,
        too_large=len(zips) > AREA_MAX_ZIPS,
        span_miles=span,
        lookup_failed=not zips and failures > 0,
    )


def _box_around(latitude: float, longitude: float, half_miles: float) -> tuple[float, float, float, float]:
    dlat = half_miles / 69.0
    dlng = half_miles / max(69.0 * math.cos(math.radians(latitude)), 1.0)
    return longitude - dlng, latitude - dlat, longitude + dlng, latitude + dlat


async def zips_in_place(
    geocoder: Geocoder,
    *,
    name: str,
    region: str | None,
    latitude: float,
    longitude: float,
    bbox: tuple[float, float, float, float] | None,
) -> AreaZips:
    """The ZIP codes of a city, most covered first (up to PLACE_MAX_LISTED).

    Points on a grid over the city's bounding box are reverse-geocoded, and only ZIP codes the map
    service files under that city are kept. When none are (some small towns share a neighbour's
    postal name), the ZIP code at the city's centre is used.
    """
    direct = getattr(geocoder, "zips_in_place", None)
    if direct is not None:  # the demo geocoder knows its cities' ZIP codes
        zips = await direct(name, region)
        return AreaZips(zip_codes=zips[:PLACE_MAX_LISTED])

    west, south, east, north = bbox or _box_around(latitude, longitude, 3)
    box = [(west, south), (east, south), (east, north), (west, north)]
    width, height = span_miles(box)
    if max(width, height) > PLACE_MAX_SPAN_MILES:
        # Very large cities: sample the area around the centre only.
        west, south, east, north = _box_around(latitude, longitude, PLACE_MAX_SPAN_MILES / 2)
        box = [(west, south), (east, south), (east, north), (west, north)]
    points = [(longitude, latitude), *sample_points(box, PLACE_GRID)]
    hits, failures = await _lookup_all(geocoder, points)

    wanted = f"{name}, {region}".lower() if region else name.lower()
    def in_city(hit: ZipAtPoint) -> bool:
        place = (hit.place or "").lower()
        return place == wanted or (not region and place.split(",")[0] == wanted)

    counts = Counter(hit.zip_code for hit in hits if hit and in_city(hit))
    zips = [z for z, _ in counts.most_common()]
    if not zips and hits and hits[0]:
        zips = [hits[0].zip_code]
    return AreaZips(
        zip_codes=zips[:PLACE_MAX_LISTED],
        span_miles=round(max(width, height), 1),
        lookup_failed=not zips and failures > 0,
    )
