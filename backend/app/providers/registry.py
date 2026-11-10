"""Chooses provider adapters from configuration.

``DATA_MODE=auto`` (default) uses live providers when a RentCast key is present
and the labelled demo dataset otherwise. Additional licensed listing feeds
(MLS / RESO Web API) plug in by appending to ``listing_providers`` — results are
deduplicated across providers by normalised address.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.config import Settings, get_settings

from .airdna import AirDNAProvider
from .base import Geocoder, ListingProvider, MarketProvider, RentProvider, StrProvider, TaxProvider, ValueProvider
from .demo import DemoProvider
from .mapbox import MapboxGeocoder
from .rentcast import RentCastProvider


@dataclass
class ProviderSet:
    mode: str  # demo | live
    listing_providers: list[ListingProvider] = field(default_factory=list)
    rent: RentProvider | None = None
    value: ValueProvider | None = None
    tax: TaxProvider | None = None
    market: MarketProvider | None = None
    short_term: StrProvider | None = None
    geocoder: Geocoder | None = None

    @property
    def is_demo(self) -> bool:
        return self.mode == "demo"

    async def aclose(self) -> None:
        seen: set[int] = set()
        for provider in [*self.listing_providers, self.rent, self.value, self.tax, self.market, self.short_term, self.geocoder]:
            closer = getattr(provider, "aclose", None)
            if provider is not None and closer and id(provider) not in seen:
                seen.add(id(provider))
                await closer()


def build_providers(settings: Settings | None = None) -> ProviderSet:
    settings = settings or get_settings()
    if settings.effective_data_mode == "demo":
        demo = DemoProvider()
        return ProviderSet(mode="demo", listing_providers=[demo], rent=demo, value=demo, market=demo, short_term=demo, geocoder=demo)

    if settings.rentcast_api_key is None:
        raise RuntimeError("DATA_MODE=live requires RENTCAST_API_KEY to be configured")
    rentcast = RentCastProvider(settings)
    return ProviderSet(
        mode="live",
        listing_providers=[rentcast],
        rent=rentcast,
        value=rentcast,
        tax=rentcast,
        market=rentcast,
        short_term=AirDNAProvider(settings) if settings.airdna_api_key else None,
        geocoder=MapboxGeocoder(settings) if settings.mapbox_access_token else None,
    )


_providers: ProviderSet | None = None


def get_providers() -> ProviderSet:
    global _providers
    if _providers is None:
        _providers = build_providers()
    return _providers


def set_providers(providers: ProviderSet | None) -> None:
    """Override the provider set (used by tests)."""
    global _providers
    _providers = providers
