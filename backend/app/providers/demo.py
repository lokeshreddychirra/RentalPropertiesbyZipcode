"""Demo data provider.

Generates a deterministic, *synthetic* dataset so the full product can be
exercised without paid API credentials. Nothing produced here is a real listing:
every record carries ``is_demo=True`` / ``provider="demo"`` and the UI labels it
as sample data everywhere it appears. Addresses are fabricated; ZIP centroids
and market price levels are only rough approximations used to make the samples
plausible.

The provider implements the same interfaces as the live adapters (including
pagination), so demo mode exercises exactly the same pipeline as live mode.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from .base import (
    BedroomStat,
    Comparable,
    GeocodeResult,
    ListingPage,
    ListingQuery,
    ListingRecord,
    MarketHistoryPoint,
    MarketStats,
    PriceEvent,
    RentEstimateRecord,
    StrEstimateRecord,
    SubjectProperty,
    ValueEstimateRecord,
)

KEY = "demo"
LEGALITY_NOTE = "Demo dataset — illustrative status only, not a legal determination."

SEASONALITY: dict[str, list[str]] = {
    "flat": ["1"] * 12,
    "urban": ["0.85", "0.9", "1.0", "1.05", "1.1", "1.1", "1.05", "1.0", "1.05", "1.1", "0.95", "0.85"],
    "florida": ["1.15", "1.25", "1.35", "1.15", "0.95", "1.0", "1.05", "0.9", "0.75", "0.85", "0.9", "1.05"],
    "beach": ["0.45", "0.55", "1.0", "0.95", "1.2", "1.75", "1.9", "1.4", "0.95", "0.8", "0.55", "0.5"],
    "mountain": ["0.8", "0.75", "0.85", "0.85", "0.95", "1.2", "1.35", "1.1", "1.0", "1.4", "1.0", "0.95"],
    "coastal": ["0.7", "0.85", "1.15", "1.25", "1.2", "1.15", "1.1", "0.95", "0.95", "1.05", "0.9", "0.75"],
    "event": ["0.7", "0.8", "0.95", "2.2", "0.95", "0.9", "0.9", "0.85", "0.9", "0.95", "0.85", "0.75"],
    "northern": ["0.65", "0.7", "0.85", "0.95", "1.1", "1.3", "1.4", "1.3", "1.1", "1.0", "0.85", "0.8"],
}


@dataclass(frozen=True)
class DemoMarket:
    zip_code: str
    city: str
    state: str
    county: str
    latitude: float
    longitude: float
    price_per_sqft: int
    rent_per_sqft: float
    adr_three_bed: int
    occupancy: int
    season: str
    legality: str  # permitted | restricted | prohibited | unknown


MARKETS: tuple[DemoMarket, ...] = (
    DemoMarket("30310", "Atlanta", "GA", "Fulton", 33.727, -84.423, 190, 1.45, 165, 58, "urban", "restricted"),
    DemoMarket("30315", "Atlanta", "GA", "Fulton", 33.703, -84.383, 175, 1.40, 150, 55, "urban", "restricted"),
    DemoMarket("30318", "Atlanta", "GA", "Fulton", 33.792, -84.447, 235, 1.55, 175, 60, "urban", "restricted"),
    DemoMarket("30331", "Atlanta", "GA", "Fulton", 33.705, -84.541, 150, 1.25, 135, 50, "urban", "restricted"),
    DemoMarket("30032", "Decatur", "GA", "DeKalb", 33.741, -84.264, 165, 1.35, 140, 52, "urban", "unknown"),
    DemoMarket("30034", "Decatur", "GA", "DeKalb", 33.691, -84.249, 150, 1.25, 130, 48, "urban", "unknown"),
    DemoMarket("30269", "Peachtree City", "GA", "Fayette", 33.397, -84.571, 215, 1.20, 160, 50, "flat", "unknown"),
    DemoMarket("31404", "Savannah", "GA", "Chatham", 32.048, -81.065, 185, 1.35, 190, 62, "coastal", "restricted"),
    DemoMarket("31405", "Savannah", "GA", "Chatham", 32.039, -81.160, 170, 1.30, 170, 58, "coastal", "unknown"),
    DemoMarket("30904", "Augusta", "GA", "Richmond", 33.477, -82.012, 120, 1.10, 175, 45, "event", "permitted"),
    DemoMarket("30906", "Augusta", "GA", "Richmond", 33.359, -82.008, 95, 1.00, 140, 40, "event", "permitted"),
    DemoMarket("31204", "Macon", "GA", "Bibb", 32.849, -83.675, 105, 1.05, 115, 42, "flat", "unknown"),
    DemoMarket("32808", "Orlando", "FL", "Orange", 28.580, -81.444, 195, 1.45, 150, 60, "florida", "unknown"),
    DemoMarket("32811", "Orlando", "FL", "Orange", 28.516, -81.444, 185, 1.45, 155, 62, "florida", "unknown"),
    DemoMarket("34746", "Kissimmee", "FL", "Osceola", 28.268, -81.467, 200, 1.30, 210, 66, "florida", "permitted"),
    DemoMarket("34747", "Kissimmee", "FL", "Osceola", 28.310, -81.590, 230, 1.30, 245, 68, "florida", "permitted"),
    DemoMarket("33604", "Tampa", "FL", "Hillsborough", 28.017, -82.455, 245, 1.60, 170, 62, "florida", "unknown"),
    DemoMarket("33610", "Tampa", "FL", "Hillsborough", 27.995, -82.404, 205, 1.50, 150, 58, "florida", "unknown"),
    DemoMarket("32205", "Jacksonville", "FL", "Duval", 30.303, -81.720, 185, 1.30, 150, 57, "florida", "unknown"),
    DemoMarket("32210", "Jacksonville", "FL", "Duval", 30.268, -81.747, 150, 1.20, 130, 52, "florida", "unknown"),
    DemoMarket("32413", "Panama City Beach", "FL", "Bay", 30.310, -85.910, 310, 1.35, 290, 60, "beach", "permitted"),
    DemoMarket("38116", "Memphis", "TN", "Shelby", 35.033, -90.011, 85, 1.00, 120, 45, "flat", "unknown"),
    DemoMarket("38118", "Memphis", "TN", "Shelby", 35.037, -89.930, 80, 0.98, 110, 42, "flat", "unknown"),
    DemoMarket("37738", "Gatlinburg", "TN", "Sevier", 35.712, -83.510, 330, 1.15, 320, 64, "mountain", "permitted"),
    DemoMarket("35206", "Birmingham", "AL", "Jefferson", 33.571, -86.713, 95, 1.02, 120, 46, "flat", "unknown"),
    DemoMarket("35215", "Birmingham", "AL", "Jefferson", 33.649, -86.657, 90, 0.98, 110, 43, "flat", "unknown"),
    DemoMarket("44105", "Cleveland", "OH", "Cuyahoga", 41.451, -81.630, 70, 1.00, 105, 44, "northern", "unknown"),
    DemoMarket("44120", "Cleveland", "OH", "Cuyahoga", 41.473, -81.580, 95, 1.05, 120, 47, "northern", "prohibited"),
    DemoMarket("46201", "Indianapolis", "IN", "Marion", 39.774, -86.109, 125, 1.15, 135, 50, "northern", "unknown"),
    DemoMarket("46218", "Indianapolis", "IN", "Marion", 39.807, -86.099, 95, 1.05, 115, 46, "northern", "unknown"),
    DemoMarket("28208", "Charlotte", "NC", "Mecklenburg", 35.232, -80.906, 240, 1.45, 160, 58, "urban", "unknown"),
    DemoMarket("28216", "Charlotte", "NC", "Mecklenburg", 35.310, -80.888, 205, 1.30, 140, 52, "urban", "unknown"),
    DemoMarket("78207", "San Antonio", "TX", "Bexar", 29.422, -98.526, 130, 1.10, 135, 52, "urban", "restricted"),
    DemoMarket("78228", "San Antonio", "TX", "Bexar", 29.459, -98.572, 140, 1.10, 130, 50, "urban", "restricted"),
)
MARKET_BY_ZIP = {m.zip_code: m for m in MARKETS}

_STREETS = (
    "Sample Oak", "Demo Maple", "Example Pine", "Placeholder Elm", "Sample Birch", "Demo Cedar", "Example Willow",
    "Sample Magnolia", "Demo Hickory", "Example Dogwood", "Sample Laurel", "Demo Sycamore", "Example Juniper",
    "Sample Chestnut", "Demo Poplar", "Example Cypress",
)
_SUFFIXES = ("St", "Ave", "Dr", "Ln", "Ct", "Way", "Rd", "Pl")
_TYPES = (("single_family", 0.68), ("townhouse", 0.13), ("condo", 0.11), ("multi_family", 0.08))
_TYPICAL_SQFT = {1: 760, 2: 1080, 3: 1480, 4: 1980, 5: 2550, 6: 3000}


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def demo_markets_summary() -> list[dict[str, str]]:
    seen: dict[tuple[str, str], list[str]] = {}
    for market in MARKETS:
        seen.setdefault((market.city, market.state), []).append(market.zip_code)
    return [{"city": city, "state": state, "zip_codes": ", ".join(zips)} for (city, state), zips in seen.items()]


def demo_legality(zip_code: str | None) -> tuple[str, str] | None:
    market = MARKET_BY_ZIP.get(zip_code or "")
    return (market.legality, LEGALITY_NOTE) if market else None


def _pick_type(rng: random.Random) -> str:
    roll, total = rng.random(), 0.0
    for name, weight in _TYPES:
        total += weight
        if roll <= total:
            return name
    return "single_family"


def _generate_zip(market: DemoMarket, today: date) -> list[ListingRecord]:
    rng = random.Random(f"propertyyield-demo:{market.zip_code}")
    count = rng.randint(30, 44)
    now = datetime.combine(today, datetime.min.time(), tzinfo=UTC) + timedelta(hours=9)
    listings: list[ListingRecord] = []
    for index in range(count):
        ptype = _pick_type(rng)
        beds = rng.choices([1, 2, 3, 4, 5], weights=[4, 22, 44, 24, 6])[0]
        if ptype == "condo":
            beds = min(beds, 3)
        if ptype == "multi_family":
            beds = rng.choice([4, 4, 5, 6])
        baths = Decimal(str(max(1.0, min(4.0, round((beds * 0.62 + rng.uniform(-0.3, 0.6)) * 2) / 2))))
        sqft = int(_TYPICAL_SQFT[beds] * rng.uniform(0.82, 1.22) / 10) * 10
        year = rng.randint(1948, 2023)
        age_discount = 1.0 - max(0, 2000 - year) * 0.0035
        quality = rng.uniform(0.78, 1.24)
        price = int(sqft * market.price_per_sqft * quality * age_discount / 100) * 100
        dom = min(int(rng.expovariate(1 / 34)), 240)
        number = rng.randint(100, 9899)
        street = f"{rng.choice(_STREETS)} {rng.choice(_SUFFIXES)}"
        unit = f"Unit {rng.randint(1, 48)}" if ptype == "condo" else None
        line1 = f"{number} {street}"
        formatted = f"{line1}{', ' + unit if unit else ''}, {market.city}, {market.state} {market.zip_code}"

        hoa: Decimal | None = None
        if ptype == "condo":
            hoa = Decimal(rng.randrange(180, 520, 5))
        elif ptype == "townhouse":
            hoa = Decimal(rng.randrange(90, 280, 5))
        elif rng.random() < 0.18:
            hoa = Decimal(rng.randrange(20, 90, 5))
        elif rng.random() < 0.75:
            hoa = Decimal(0)  # reported as "no HOA"; None means the listing did not say

        tax = Decimal(int(price * rng.uniform(0.0075, 0.0165) / 10) * 10) if rng.random() < 0.74 else None

        listed = today - timedelta(days=dom)
        history = [PriceEvent(event_date=listed, event_type="listed", price=Decimal(price))]
        if dom > 21 and rng.random() < 0.42:
            original = int(price * rng.uniform(1.025, 1.09) / 100) * 100
            history = [
                PriceEvent(event_date=listed, event_type="listed", price=Decimal(original)),
                PriceEvent(event_date=listed + timedelta(days=rng.randint(10, max(11, dom - 3))), event_type="price_change", price=Decimal(price)),
            ]

        stale_roll = rng.random()
        seen_days = rng.randint(9, 40) if stale_roll < 0.06 else rng.randint(3, 6) if stale_roll < 0.2 else rng.randint(0, 1)
        last_seen = now - timedelta(days=seen_days, hours=rng.randint(0, 6))

        missing_roll = rng.random()
        listings.append(
            ListingRecord(
                provider=KEY,
                provider_listing_id=f"demo-{market.zip_code}-{index:03d}",
                status="active",
                listing_type="Standard",
                formatted_address=formatted,
                address_line1=line1,
                address_line2=unit,
                city=market.city,
                state=market.state,
                zip_code=market.zip_code,
                county=market.county,
                latitude=round(market.latitude + rng.uniform(-0.028, 0.028), 6),
                longitude=round(market.longitude + rng.uniform(-0.034, 0.034), 6),
                property_type=ptype,  # type: ignore[arg-type]
                bedrooms=Decimal(beds),
                bathrooms=baths,
                square_feet=None if missing_roll < 0.03 else sqft,
                lot_size_sqft=None if ptype == "condo" else rng.randrange(2800, 16000, 100),
                year_built=None if 0.03 <= missing_roll < 0.07 else year,
                price=Decimal(price),
                listed_date=listed,
                days_on_market=dom,
                hoa_fee_monthly=hoa,
                property_tax_annual=tax,
                property_tax_year=today.year - 1 if tax is not None else None,
                description=(
                    f"Sample {beds}-bedroom {ptype.replace('_', ' ')} generated for the PropertyYield AI demo dataset. "
                    "This is not a real property or a real listing."
                ),
                mls_name="Demo MLS",
                mls_number=f"D{market.zip_code}{index:03d}",
                last_seen_at=last_seen,
                source_updated_at=last_seen,
                price_history=history,
                is_demo=True,
            )
        )
    return listings


class DemoProvider:
    """Implements listing, rent, value, market, STR and geocoding interfaces with synthetic data."""

    key = KEY
    name = "Demo dataset"
    attribution = "Synthetic sample data — not real listings"
    page_size = 25  # deliberately small so pagination is always exercised

    def __init__(self, today: date | None = None):
        self._today = today
        self._cache: dict[tuple[str, date], list[ListingRecord]] = {}

    def _listings_for_zip(self, zip_code: str) -> list[ListingRecord]:
        today = self._today or datetime.now(UTC).date()
        market = MARKET_BY_ZIP.get(zip_code)
        if market is None:
            return []
        key = (zip_code, today)
        if key not in self._cache:
            self._cache = {k: v for k, v in self._cache.items() if k[1] == today}
            self._cache[key] = _generate_zip(market, today)
        return self._cache[key]

    def _matching(self, query: ListingQuery) -> list[ListingRecord]:
        if query.latitude is not None and query.longitude is not None and query.radius_miles:
            out: list[ListingRecord] = []
            for market in MARKETS:
                if haversine_miles(query.latitude, query.longitude, market.latitude, market.longitude) > query.radius_miles + 5:
                    continue
                out.extend(
                    listing
                    for listing in self._listings_for_zip(market.zip_code)
                    if haversine_miles(query.latitude, query.longitude, listing.latitude or 0, listing.longitude or 0) <= query.radius_miles
                )
            return out
        if query.zip_code:
            return list(self._listings_for_zip(query.zip_code))
        if query.city:
            city = query.city.strip().lower()
            zips = [m.zip_code for m in MARKETS if m.city.lower() == city and (not query.state or m.state == query.state.upper())]
            return [listing for z in zips for listing in self._listings_for_zip(z)]
        if query.state:
            zips = [m.zip_code for m in MARKETS if m.state == query.state.upper()]
            return [listing for z in zips for listing in self._listings_for_zip(z)]
        return []

    async def search_listings(self, query: ListingQuery, *, offset: int, limit: int) -> ListingPage:
        limit = max(1, min(limit, self.page_size))
        matching = self._matching(query)
        page = matching[offset : offset + limit]
        return ListingPage(listings=page, has_more=offset + limit < len(matching), next_offset=offset + len(page), total_count=len(matching))

    # ------------------------------------------------------------------ estimates

    @staticmethod
    def _rng(subject: SubjectProperty, salt: str) -> random.Random:
        return random.Random(f"propertyyield-demo:{salt}:{subject.seed or subject.formatted_address}")

    @staticmethod
    def _comps(rng: random.Random, subject: SubjectProperty, count: int, base: float, market: DemoMarket, step: int) -> list[Comparable]:
        comps = []
        beds = int(subject.bedrooms or 3)
        for _ in range(count):
            comp_beds = max(1, beds + rng.choice([0, 0, 0, -1, 1]))
            sqft = int((subject.square_feet or _TYPICAL_SQFT.get(beds, 1500)) * rng.uniform(0.85, 1.18) / 10) * 10
            comps.append(
                Comparable(
                    formatted_address=f"{rng.randint(100, 9899)} {rng.choice(_STREETS)} {rng.choice(_SUFFIXES)}, {market.city}, {market.state} {market.zip_code}",
                    latitude=round((subject.latitude or market.latitude) + rng.uniform(-0.012, 0.012), 6),
                    longitude=round((subject.longitude or market.longitude) + rng.uniform(-0.014, 0.014), 6),
                    price=Decimal(int(base * rng.uniform(0.9, 1.11) / step) * step),
                    bedrooms=Decimal(comp_beds),
                    bathrooms=subject.bathrooms,
                    square_feet=sqft,
                    property_type=subject.property_type,  # type: ignore[arg-type]
                    year_built=rng.randint(1955, 2022),
                    distance_miles=Decimal(str(round(rng.uniform(0.08, 1.9), 2))),
                    days_old=rng.randint(2, 120),
                    similarity=Decimal(str(round(rng.uniform(0.82, 0.99), 3))),
                    listed_date=(datetime.now(UTC) - timedelta(days=rng.randint(2, 120))).date(),
                )
            )
        return sorted(comps, key=lambda c: c.distance_miles or Decimal(0))

    async def rent_estimate(self, subject: SubjectProperty) -> RentEstimateRecord | None:
        market = MARKET_BY_ZIP.get(subject.zip_code or "")
        if market is None:
            return None
        rng = self._rng(subject, "rent")
        if rng.random() < 0.05:  # some homes have no reliable estimate, as in real data
            return None
        beds = int(subject.bedrooms or 3)
        sqft = subject.square_feet or _TYPICAL_SQFT.get(beds, 1500)
        size_adjust = (1500 / sqft) ** 0.28  # larger homes rent for less per square foot
        rent = sqft * market.rent_per_sqft * size_adjust * rng.uniform(0.9, 1.1)
        rent = int(rent / 5) * 5
        comp_count = rng.choice([2, 4, 5, 6, 7, 8, 9, 10])
        spread = rng.uniform(0.06, 0.12)
        return RentEstimateRecord(
            provider=KEY,
            level="property",
            rent=Decimal(rent),
            rent_low=Decimal(int(rent * (1 - spread) / 5) * 5),
            rent_high=Decimal(int(rent * (1 + spread) / 5) * 5),
            comparables=self._comps(rng, subject, comp_count, rent, market, 5),
            fetched_at=datetime.now(UTC),
        )

    async def value_estimate(self, subject: SubjectProperty) -> ValueEstimateRecord | None:
        market = MARKET_BY_ZIP.get(subject.zip_code or "")
        if market is None or subject.price is None:
            return None
        rng = self._rng(subject, "value")
        value = int(float(subject.price) * rng.uniform(0.93, 1.13) / 100) * 100
        return ValueEstimateRecord(
            provider=KEY,
            value=Decimal(value),
            value_low=Decimal(int(value * 0.93 / 100) * 100),
            value_high=Decimal(int(value * 1.07 / 100) * 100),
            comparables=self._comps(rng, subject, rng.randint(5, 9), value, market, 100),
            fetched_at=datetime.now(UTC),
        )

    async def str_estimate(self, subject: SubjectProperty) -> StrEstimateRecord | None:
        market = MARKET_BY_ZIP.get(subject.zip_code or "")
        if market is None:
            return None
        rng = self._rng(subject, "str")
        if rng.random() < 0.08:
            return None
        beds = int(subject.bedrooms or 3)
        adr = market.adr_three_bed * (0.52 + 0.16 * beds) * rng.uniform(0.9, 1.12)
        occupancy = max(25.0, min(82.0, market.occupancy + rng.uniform(-8, 7)))
        adr_dec = Decimal(str(round(adr, 2)))
        occ_dec = Decimal(str(round(occupancy, 1)))
        return StrEstimateRecord(
            provider=KEY,
            level="property",
            adr=adr_dec,
            occupancy_pct=occ_dec,
            occupancy_basis="available",
            annual_revenue=(adr_dec * Decimal(365) * occ_dec / 100).quantize(Decimal("0.01")),
            cleaning_fee=Decimal(60 + 25 * beds),
            adr_includes_cleaning_fee=False,
            avg_stay_nights=Decimal(str(round(rng.uniform(2.6, 4.8), 1))),
            seasonality=[Decimal(w) for w in SEASONALITY[market.season]],
            comp_count=rng.randint(6, 40),
            fetched_at=datetime.now(UTC),
        )

    async def market_stats(self, zip_code: str) -> MarketStats | None:
        market = MARKET_BY_ZIP.get(zip_code)
        if market is None:
            return None
        rng = random.Random(f"propertyyield-demo:market:{zip_code}")
        listings = self._listings_for_zip(zip_code)
        rent_rows, sale_rows = [], []
        for beds in (1, 2, 3, 4, 5):
            sqft = _TYPICAL_SQFT[beds]
            rent = int(sqft * market.rent_per_sqft * (1500 / sqft) ** 0.28 / 5) * 5
            sample = rng.randint(6, 70)
            rent_rows.append(
                BedroomStat(bedrooms=beds, median=Decimal(rent), average=Decimal(int(rent * 1.02)), low=Decimal(int(rent * 0.78)), high=Decimal(int(rent * 1.3)), count=sample)
            )
            prices = sorted(float(listing.price or 0) for listing in listings if listing.bedrooms == beds)
            if prices:
                sale_rows.append(
                    BedroomStat(bedrooms=beds, median=Decimal(int(prices[len(prices) // 2])), average=Decimal(int(sum(prices) / len(prices))), low=Decimal(int(prices[0])), high=Decimal(int(prices[-1])), count=len(prices))
                )
        all_prices = sorted(float(listing.price or 0) for listing in listings)
        median_price = all_prices[len(all_prices) // 2] if all_prices else 0
        median_rent = float(rent_rows[2].median or 0)
        history = []
        today = self._today or datetime.now(UTC).date()
        for back in range(11, -1, -1):
            month_index = today.year * 12 + today.month - 1 - back
            label = f"{month_index // 12:04d}-{month_index % 12 + 1:02d}"
            drift = 1 - back * 0.0028
            history.append(
                MarketHistoryPoint(
                    month=label,
                    median_rent=Decimal(int(median_rent * drift * rng.uniform(0.992, 1.008))),
                    median_sale_price=Decimal(int(median_price * (1 - back * 0.0031) * rng.uniform(0.985, 1.015) / 100) * 100),
                    rental_listings=rng.randint(40, 160),
                    sale_listings=max(len(listings) + rng.randint(-8, 8), 1),
                )
            )
        doms = sorted(listing.days_on_market or 0 for listing in listings)
        return MarketStats(
            provider=KEY,
            zip_code=zip_code,
            median_rent=Decimal(int(median_rent)),
            average_rent=Decimal(int(median_rent * 1.03)),
            rental_listings=sum(r.count for r in rent_rows),
            median_rent_per_sqft=Decimal(str(market.rent_per_sqft)),
            rental_median_days_on_market=Decimal(rng.randint(18, 38)),
            rent_by_bedrooms=rent_rows,
            median_sale_price=Decimal(int(median_price)),
            average_sale_price=Decimal(int(sum(all_prices) / len(all_prices))) if all_prices else None,
            sale_listings=len(listings),
            median_price_per_sqft=Decimal(market.price_per_sqft),
            sale_median_days_on_market=Decimal(doms[len(doms) // 2]) if doms else None,
            sale_by_bedrooms=sale_rows,
            history=history,
            fetched_at=datetime.now(UTC),
            is_demo=True,
        )

    # ------------------------------------------------------------------ geocoding

    async def geocode(self, query: str, *, kinds: tuple[str, ...] = ()) -> GeocodeResult | None:
        text = query.strip().lower()
        if text in MARKET_BY_ZIP:
            market = MARKET_BY_ZIP[text]
            return GeocodeResult(name=f"{market.zip_code} {market.city}, {market.state}", latitude=market.latitude, longitude=market.longitude, kind="postcode")
        parts = [p.strip() for p in text.replace(" county", "").split(",")]
        name, state = parts[0], (parts[1].upper() if len(parts) > 1 and parts[1] else None)
        matches = [
            m for m in MARKETS if (m.city.lower() == name or m.county.lower() == name) and (state is None or m.state == state)
        ]
        if not matches:
            return None
        return GeocodeResult(
            name=f"{matches[0].city}, {matches[0].state}",
            latitude=sum(m.latitude for m in matches) / len(matches),
            longitude=sum(m.longitude for m in matches) / len(matches),
            kind="place",
        )
