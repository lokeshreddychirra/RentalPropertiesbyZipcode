"""Normalized PostgreSQL schema (PostGIS-enabled).

Entity overview
---------------
properties ─┬─ property_listings ── property_listing_sources   (one canonical listing, many provider sources)
            ├─ property_images / property_price_history / property_expenses
            ├─ rent_estimates ── rental_comparables
            ├─ value_estimates ── sale_comparables
            ├─ short_term_rental_estimates
            └─ investment_analyses / favorite_properties
users ──┬─ user_preferences / financing_scenarios / saved_searches / watchlists
        └─ notifications
providers ── provider_api_usage
str_regulations, market_snapshots  (reference data keyed by jurisdiction / ZIP)
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from geoalchemy2 import Geography
from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base

Money = Numeric(14, 2)
Rate = Numeric(7, 3)


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _updated() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


# --------------------------------------------------------------------------- users


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str | None] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(20), default="user")  # user | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _created()
    # Subscription plan: free | pro | premium (see app/services/plans.py).
    plan: Mapped[str] = mapped_column(String(20), default="free", server_default="free")
    plan_status: Mapped[str | None] = mapped_column(String(30))  # Stripe subscription status, when billed online
    plan_renews_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(64))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    login_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    preferences: Mapped[UserPreference | None] = relationship(back_populates="user", uselist=False, cascade="all, delete-orphan")


class PlanConfig(Base):
    """Administrator overrides for a plan's price and allowances (environment values are the defaults)."""

    __tablename__ = "plan_configs"

    key: Mapped[str] = mapped_column(String(20), primary_key=True)  # free | pro | premium
    price_usd: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    zip_searches: Mapped[int | None] = mapped_column(Integer)  # None = unlimited
    property_reports: Mapped[int | None] = mapped_column(Integer)
    zips_per_search: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = _updated()


class UserUsage(Base):
    """One row per distinct billable item a user consumed in a period (a ZIP searched, a property report)."""

    __tablename__ = "user_usage"
    __table_args__ = (UniqueConstraint("user_id", "kind", "item", "period"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # zip_search | property_report
    item: Mapped[str] = mapped_column(String(64))
    period: Mapped[str] = mapped_column(String(10))  # "lifetime" or "YYYY-MM"
    created_at: Mapped[datetime] = _created()


class UserPreference(Base):
    __tablename__ = "user_preferences"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    default_assumptions: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    score_weights: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    notification_settings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = _updated()

    user: Mapped[User] = relationship(back_populates="preferences")


# --------------------------------------------------------------------------- providers


class Provider(Base):
    """Data providers plus their admin-configurable usage budgets."""

    __tablename__ = "providers"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(40))  # listings | str | geocoding | llm | demo
    attribution: Mapped[str | None] = mapped_column(String(255))
    terms_url: Mapped[str | None] = mapped_column(String(500))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    monthly_request_limit: Mapped[int | None] = mapped_column(Integer)
    monthly_cost_limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    cost_per_request_usd: Mapped[Decimal] = mapped_column(Numeric(10, 5), default=Decimal("0"))
    updated_at: Mapped[datetime] = _updated()


class ProviderApiUsage(Base):
    __tablename__ = "provider_api_usage"
    __table_args__ = (Index("ix_provider_api_usage_provider_created", "provider_key", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    provider_key: Mapped[str] = mapped_column(ForeignKey("providers.key", ondelete="CASCADE"))
    endpoint: Mapped[str] = mapped_column(String(120))
    status_code: Mapped[int | None] = mapped_column(Integer)
    ok: Mapped[bool] = mapped_column(Boolean)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 5), default=Decimal("0"))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = _created()


# --------------------------------------------------------------------------- properties


class Property(Base):
    __tablename__ = "properties"
    __table_args__ = (
        Index("ix_properties_location", "location", postgresql_using="gist"),
        Index("ix_properties_state_city", "state", "city"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # Normalised address key used to deduplicate the same home across providers.
    dedupe_key: Mapped[str] = mapped_column(String(255), unique=True)
    formatted_address: Mapped[str] = mapped_column(String(300))
    address_line1: Mapped[str | None] = mapped_column(String(200))
    address_line2: Mapped[str | None] = mapped_column(String(80))
    city: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(2))
    zip_code: Mapped[str | None] = mapped_column(String(10), index=True)
    county: Mapped[str | None] = mapped_column(String(120))
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    location: Mapped[Any | None] = mapped_column(Geography(geometry_type="POINT", srid=4326, spatial_index=False))
    property_type: Mapped[str | None] = mapped_column(String(30))
    bedrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    bathrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    square_feet: Mapped[int | None] = mapped_column(Integer)
    lot_size_sqft: Mapped[int | None] = mapped_column(Integer)
    year_built: Mapped[int | None] = mapped_column(Integer)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    listing: Mapped[PropertyListing | None] = relationship(back_populates="property", uselist=False, cascade="all, delete-orphan")
    images: Mapped[list[PropertyImage]] = relationship(cascade="all, delete-orphan", order_by="PropertyImage.position")
    price_history: Mapped[list[PropertyPriceHistory]] = relationship(cascade="all, delete-orphan", order_by="PropertyPriceHistory.event_date")
    rent_estimates: Mapped[list[RentEstimate]] = relationship(cascade="all, delete-orphan")
    value_estimates: Mapped[list[ValueEstimate]] = relationship(cascade="all, delete-orphan")
    str_estimates: Mapped[list[ShortTermRentalEstimate]] = relationship(cascade="all, delete-orphan")
    expenses: Mapped[list[PropertyExpense]] = relationship(cascade="all, delete-orphan")


class PropertyListing(Base):
    """The current canonical for-sale listing of a property (merged across providers)."""

    __tablename__ = "property_listings"

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), unique=True)
    status: Mapped[str] = mapped_column(String(20), index=True)  # active | inactive | unknown
    listing_type: Mapped[str | None] = mapped_column(String(40))
    price: Mapped[Decimal | None] = mapped_column(Money, index=True)
    listed_date: Mapped[date | None] = mapped_column(Date)
    removed_date: Mapped[date | None] = mapped_column(Date)
    days_on_market: Mapped[int | None] = mapped_column(Integer)
    hoa_fee_monthly: Mapped[Decimal | None] = mapped_column(Money)
    description: Mapped[str | None] = mapped_column(Text)
    listing_url: Mapped[str | None] = mapped_column(String(1000))
    mls_name: Mapped[str | None] = mapped_column(String(120))
    mls_number: Mapped[str | None] = mapped_column(String(60))
    agent_name: Mapped[str | None] = mapped_column(String(160))
    office_name: Mapped[str | None] = mapped_column(String(160))
    primary_provider: Mapped[str] = mapped_column(String(40))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    property: Mapped[Property] = relationship(back_populates="listing")
    sources: Mapped[list[PropertyListingSource]] = relationship(cascade="all, delete-orphan")


class PropertyListingSource(Base):
    """One provider's record of a listing. Several sources can back one listing."""

    __tablename__ = "property_listing_sources"
    __table_args__ = (UniqueConstraint("provider_key", "provider_listing_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    listing_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("property_listings.id", ondelete="CASCADE"), index=True)
    provider_key: Mapped[str] = mapped_column(String(40))
    provider_listing_id: Mapped[str] = mapped_column(String(255))
    price: Mapped[Decimal | None] = mapped_column(Money)
    status: Mapped[str | None] = mapped_column(String(20))
    source_url: Mapped[str | None] = mapped_column(String(1000))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class PropertyImage(Base):
    __tablename__ = "property_images"
    __table_args__ = (UniqueConstraint("property_id", "url"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    url: Mapped[str] = mapped_column(String(1000))
    position: Mapped[int] = mapped_column(Integer, default=0)
    provider_key: Mapped[str] = mapped_column(String(40))
    attribution: Mapped[str | None] = mapped_column(String(255))


class PropertyPriceHistory(Base):
    __tablename__ = "property_price_history"
    __table_args__ = (UniqueConstraint("property_id", "event_date", "event_type", "price"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    event_date: Mapped[date] = mapped_column(Date)
    event_type: Mapped[str] = mapped_column(String(40))  # listed | price_change | removed | sold
    price: Mapped[Decimal | None] = mapped_column(Money)
    provider_key: Mapped[str] = mapped_column(String(40))


class PropertyExpense(Base):
    """Source-reported recurring ownership costs (e.g. property tax from public record)."""

    __tablename__ = "property_expenses"
    __table_args__ = (UniqueConstraint("property_id", "kind", "year"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # property_tax | insurance | hoa
    annual_amount: Mapped[Decimal] = mapped_column(Money)
    year: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(60))
    provider_key: Mapped[str] = mapped_column(String(40))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# --------------------------------------------------------------------------- estimates


class RentEstimate(Base):
    __tablename__ = "rent_estimates"
    __table_args__ = (UniqueConstraint("property_id", "provider_key", "level"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    provider_key: Mapped[str] = mapped_column(String(40))
    level: Mapped[str] = mapped_column(String(20))  # property | market_zip
    rent: Mapped[Decimal] = mapped_column(Money)
    rent_low: Mapped[Decimal | None] = mapped_column(Money)
    rent_high: Mapped[Decimal | None] = mapped_column(Money)
    comp_count: Mapped[int] = mapped_column(Integer, default=0)
    market_sample: Mapped[int] = mapped_column(Integer, default=0)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    comparables: Mapped[list[RentalComparable]] = relationship(cascade="all, delete-orphan", order_by="RentalComparable.distance_miles")


class RentalComparable(Base):
    __tablename__ = "rental_comparables"

    id: Mapped[uuid.UUID] = _uuid_pk()
    rent_estimate_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rent_estimates.id", ondelete="CASCADE"), index=True)
    formatted_address: Mapped[str] = mapped_column(String(300))
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    rent: Mapped[Decimal | None] = mapped_column(Money)
    bedrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    bathrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    square_feet: Mapped[int | None] = mapped_column(Integer)
    property_type: Mapped[str | None] = mapped_column(String(30))
    distance_miles: Mapped[Decimal | None] = mapped_column(Numeric(7, 3))
    days_old: Mapped[int | None] = mapped_column(Integer)
    similarity: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    listed_date: Mapped[date | None] = mapped_column(Date)


class ValueEstimate(Base):
    __tablename__ = "value_estimates"
    __table_args__ = (UniqueConstraint("property_id", "provider_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    provider_key: Mapped[str] = mapped_column(String(40))
    value: Mapped[Decimal] = mapped_column(Money)
    value_low: Mapped[Decimal | None] = mapped_column(Money)
    value_high: Mapped[Decimal | None] = mapped_column(Money)
    comp_count: Mapped[int] = mapped_column(Integer, default=0)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    comparables: Mapped[list[SaleComparable]] = relationship(cascade="all, delete-orphan", order_by="SaleComparable.distance_miles")


class SaleComparable(Base):
    __tablename__ = "sale_comparables"

    id: Mapped[uuid.UUID] = _uuid_pk()
    value_estimate_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("value_estimates.id", ondelete="CASCADE"), index=True)
    formatted_address: Mapped[str] = mapped_column(String(300))
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    price: Mapped[Decimal | None] = mapped_column(Money)
    bedrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    bathrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    square_feet: Mapped[int | None] = mapped_column(Integer)
    property_type: Mapped[str | None] = mapped_column(String(30))
    year_built: Mapped[int | None] = mapped_column(Integer)
    distance_miles: Mapped[Decimal | None] = mapped_column(Numeric(7, 3))
    days_old: Mapped[int | None] = mapped_column(Integer)
    similarity: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    listed_date: Mapped[date | None] = mapped_column(Date)


class ShortTermRentalEstimate(Base):
    __tablename__ = "short_term_rental_estimates"
    __table_args__ = (UniqueConstraint("property_id", "provider_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    provider_key: Mapped[str] = mapped_column(String(40))
    level: Mapped[str] = mapped_column(String(20))  # property | market
    adr: Mapped[Decimal] = mapped_column(Money)
    occupancy_pct: Mapped[Decimal] = mapped_column(Rate)
    occupancy_basis: Mapped[str] = mapped_column(String(12), default="available")
    annual_revenue: Mapped[Decimal | None] = mapped_column(Money)
    cleaning_fee: Mapped[Decimal | None] = mapped_column(Money)
    adr_includes_cleaning_fee: Mapped[bool] = mapped_column(Boolean, default=False)
    avg_stay_nights: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    seasonality: Mapped[list[Any] | None] = mapped_column(JSONB)
    comp_count: Mapped[int] = mapped_column(Integer, default=0)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class StrRegulation(Base):
    """Registry of *verified* local short-term-rental rules, maintained by admins.

    A jurisdiction with no row is "unknown / needs verification" — legality is
    never inferred from nearby listings.
    """

    __tablename__ = "str_regulations"
    __table_args__ = (UniqueConstraint("jurisdiction_type", "jurisdiction_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    jurisdiction_type: Mapped[str] = mapped_column(String(10))  # zip | city | county | state
    jurisdiction_key: Mapped[str] = mapped_column(String(160))  # e.g. "30303", "atlanta,ga", "fulton,ga", "ga"
    status: Mapped[str] = mapped_column(String(12))  # permitted | restricted | prohibited
    summary: Mapped[str | None] = mapped_column(Text)
    max_nights_per_year: Mapped[int | None] = mapped_column(Integer)
    source_url: Mapped[str | None] = mapped_column(String(1000))
    verified_at: Mapped[date | None] = mapped_column(Date)
    verified_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class MarketSnapshot(Base):
    __tablename__ = "market_snapshots"
    __table_args__ = (UniqueConstraint("zip_code", "provider_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    zip_code: Mapped[str] = mapped_column(String(10), index=True)
    provider_key: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# --------------------------------------------------------------------------- user data


class FinancingScenario(Base):
    __tablename__ = "financing_scenarios"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    property_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    down_payment_pct: Mapped[Decimal] = mapped_column(Rate)
    interest_rate_pct: Mapped[Decimal] = mapped_column(Rate)
    loan_term_years: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = _created()


class InvestmentAnalysis(Base):
    """A saved evaluation: the exact assumptions used and the headline results."""

    __tablename__ = "investment_analyses"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"), index=True)
    name: Mapped[str | None] = mapped_column(String(120))
    overrides: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    assumptions: Mapped[dict[str, Any]] = mapped_column(JSONB)
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB)
    recommended_strategy: Mapped[str | None] = mapped_column(String(4))
    score: Mapped[Decimal | None] = mapped_column(Numeric(5, 1))
    created_at: Mapped[datetime] = _created()

    property: Mapped[Property] = relationship()


class SavedSearch(Base):
    __tablename__ = "saved_searches"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    filters: Mapped[dict[str, Any]] = mapped_column(JSONB)
    overrides: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    alerts_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_new_listings: Mapped[bool] = mapped_column(Boolean, default=True)
    notify_price_reductions: Mapped[bool] = mapped_column(Boolean, default=True)
    cash_flow_threshold: Mapped[Decimal | None] = mapped_column(Money)
    gross_yield_threshold: Mapped[Decimal | None] = mapped_column(Rate)
    # property_id -> last known price, used to detect new listings and reductions
    known_listings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class Watchlist(Base):
    __tablename__ = "watchlists"
    __table_args__ = (UniqueConstraint("user_id", "name"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = _created()


class FavoriteProperty(Base):
    __tablename__ = "favorite_properties"
    __table_args__ = (UniqueConstraint("user_id", "property_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    property_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("properties.id", ondelete="CASCADE"))
    watchlist_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("watchlists.id", ondelete="SET NULL"))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()

    property: Mapped[Property] = relationship()


class Notification(Base):
    __tablename__ = "notifications"
    # The dedupe key makes alert delivery idempotent: the same event for the
    # same user can never be stored (or emailed) twice.
    __table_args__ = (UniqueConstraint("user_id", "dedupe_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    saved_search_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("saved_searches.id", ondelete="SET NULL"))
    property_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("properties.id", ondelete="SET NULL"))
    type: Mapped[str] = mapped_column(String(30))  # new_listing | price_reduction | cash_flow_threshold | yield_threshold
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    dedupe_key: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = _created()
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    emailed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
