"""ZIP codes covered by a shape drawn on the results map.

Searches are bought per ZIP code, so a drawn area is turned into the ZIP codes it covers: a small grid
of points inside the shape is reverse-geocoded (geocoder only, no listing requests) and the distinct
postcodes are collected. Areas that are too wide, or that cover more than ``AREA_MAX_ZIPS`` ZIP codes,
are refused with a request to zoom in and draw a smaller area.
"""

from __future__ import annotations

import asyncio
import math
from collections import Counter
from dataclasses import dataclass, field

from app.providers.base import BudgetExceeded, Geocoder, ProviderError

from .plans import AREA_MAX_ZIPS
from .search import miles_between, point_in_polygon

# Wider than this (in either direction) is refused before any lookup: it would cover far more than
# AREA_MAX_ZIPS ZIP codes almost anywhere.
AREA_MAX_SPAN_MILES = 30.0
# Grid density: at most GRID x GRID sample points, never closer than MIN_SPACING_MILES apart.
GRID = 5
MIN_SPACING_MILES = 0.6
LOOKUP_CONCURRENCY = 6


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


def sample_points(polygon: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Grid points (lng, lat) inside the shape: cell centres of an up-to GRID x GRID grid over its bounding box."""
    lngs = [p[0] for p in polygon]
    lats = [p[1] for p in polygon]
    west, east, south, north = min(lngs), max(lngs), min(lats), max(lats)
    width, height = span_miles(polygon)
    spacing = max(MIN_SPACING_MILES, max(width, height) / GRID)
    nx = max(1, min(GRID, math.ceil(width / spacing)))
    ny = max(1, min(GRID, math.ceil(height / spacing)))
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


async def zips_in_area(geocoder: Geocoder, polygon: list[tuple[float, float]]) -> AreaZips:
    width, height = span_miles(polygon)
    span = round(max(width, height), 1)
    if span > AREA_MAX_SPAN_MILES:
        return AreaZips(too_large=True, span_miles=span)

    semaphore = asyncio.Semaphore(LOOKUP_CONCURRENCY)
    failures = 0

    async def lookup(lng: float, lat: float) -> str | None:
        nonlocal failures
        async with semaphore:
            try:
                hit = await geocoder.zip_at(round(lat, 4), round(lng, 4))
            except (ProviderError, BudgetExceeded):
                failures += 1
                return None
        return hit.zip_code if hit else None

    points = sample_points(polygon)
    found = await asyncio.gather(*(lookup(lng, lat) for lng, lat in points))
    counts = Counter(z for z in found if z)
    # Most-covered ZIP codes first.
    zips = [z for z, _ in counts.most_common()]
    return AreaZips(
        zip_codes=zips,
        too_large=len(zips) > AREA_MAX_ZIPS,
        span_miles=span,
        lookup_failed=not zips and failures > 0,
    )
