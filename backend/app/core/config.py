"""Application configuration.

All configuration comes from environment variables (or a local ``.env`` file in
development). Nothing secret is hardcoded: defaults below are either non-secret
tuning values or obviously-unsafe development placeholders that the app refuses
to run with in production (see ``Settings.validate_for_production``).
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_SECRET = "dev-only-insecure-secret-change-me-0123456789abcdef"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Runtime -----------------------------------------------------------
    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    # --- Storage -----------------------------------------------------------
    database_url: str = "postgresql+asyncpg://propertyyield:propertyyield@localhost:5432/propertyyield"
    redis_url: str = "redis://localhost:6379/0"

    # --- Auth --------------------------------------------------------------
    secret_key: SecretStr = SecretStr(_DEV_SECRET)
    access_token_ttl_minutes: int = 60 * 24 * 7
    session_cookie_name: str = "py_session"
    session_cookie_secure: bool = False
    admin_emails: list[str] = Field(default_factory=list)
    allow_registration: bool = True

    # --- Data mode ---------------------------------------------------------
    # auto  -> live when a RentCast key is configured, otherwise demo
    # demo  -> always use the bundled, clearly-labelled sample dataset
    # live  -> require live providers; fail loudly if not configured
    data_mode: Literal["auto", "demo", "live"] = "auto"

    # --- RentCast (listings, rent AVM, value AVM, market stats) -------------
    rentcast_api_key: SecretStr | None = None
    rentcast_base_url: str = "https://api.rentcast.io/v1"
    rentcast_page_size: int = 500
    rentcast_requests_per_second: float = 15.0
    # Enable only if your RentCast API version supports ``min:max`` range syntax
    # on numeric query parameters. When false, ranges are filtered locally.
    rentcast_range_filters: bool = False
    # Defaults for RentCast's Foundation plan ($74 for 1,000 requests a month, then $0.06 each), with a
    # 500 request safety limit. Administrators change the budget under Admin Portal -> API usage.
    rentcast_cost_per_request_usd: Decimal = Decimal("0.074")
    rentcast_monthly_request_budget: int = 500
    rentcast_monthly_cost_budget_usd: Decimal = Decimal("74")

    # --- AirDNA (short-term rental analytics) -------------------------------
    airdna_api_key: SecretStr | None = None
    airdna_base_url: str = "https://api.airdna.co/api/enterprise/v2"
    airdna_requests_per_second: float = 2.0
    airdna_cost_per_request_usd: Decimal = Decimal("0.50")
    airdna_monthly_request_budget: int = 200
    airdna_monthly_cost_budget_usd: Decimal = Decimal("100")

    # --- Mapbox (server-side geocoding; the browser token is a frontend env) -
    mapbox_access_token: SecretStr | None = None
    mapbox_cost_per_request_usd: Decimal = Decimal("0.00075")
    mapbox_monthly_request_budget: int = 50000
    mapbox_monthly_cost_budget_usd: Decimal = Decimal("25")

    # --- LLM ---------------------------------------------------------------
    llm_provider: Literal["anthropic", "none"] = "anthropic"
    anthropic_api_key: SecretStr | None = None
    llm_model: str = "claude-opus-5-5"
    llm_effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"
    llm_max_tokens: int = 4000
    llm_timeout_seconds: float = 90.0
    # Server-side refusal fallback (Anthropic beta). Disable if your account or
    # platform (Bedrock/Vertex/Foundry) does not support it.
    llm_refusal_fallback: bool = True
    llm_cost_per_request_usd: Decimal = Decimal("0.03")
    llm_monthly_request_budget: int = 2000
    llm_monthly_cost_budget_usd: Decimal = Decimal("50")

    # --- Plans & billing -------------------------------------------------------
    # Quotas apply in live data mode only (demo data costs nothing). Administrators are unlimited.
    # "ZIP searches" count distinct ZIP codes per period; "property reports" count properties whose
    # property-level estimates had to be bought from the data provider.
    plan_free_zip_searches: int = 1  # lifetime
    plan_free_property_reports: int = 3  # lifetime
    plan_pro_price_usd: Decimal = Decimal("19")
    plan_pro_zip_searches: int = 5  # per month
    plan_pro_property_reports: int = 20
    plan_premium_price_usd: Decimal = Decimal("49")
    plan_premium_zip_searches: int = 15
    plan_premium_property_reports: int = 60
    # Online payments (Stripe Checkout + Billing Portal). Without these, an administrator assigns plans.
    stripe_secret_key: SecretStr | None = None
    stripe_webhook_secret: SecretStr | None = None
    stripe_price_pro: str | None = None
    stripe_price_premium: str | None = None
    stripe_api_base: str = "https://api.stripe.com/v1"

    # --- Freshness thresholds (how long cached provider data is reused) -----
    listing_cache_ttl_seconds: int = 24 * 3600  # default; administrators can change it in the admin portal
    # After that, cached listings are still shown instantly for up to this many days while a fresh copy
    # is fetched in the background (0 = always wait for fresh listings). Also changeable in the admin portal.
    listing_stale_days: int = 7
    rent_estimate_ttl_days: int = 30
    value_estimate_ttl_days: int = 30
    str_estimate_ttl_days: int = 30
    market_stats_ttl_days: int = 30
    search_result_ttl_seconds: int = 3600

    # --- Search pipeline / cost control --------------------------------------
    # Safety cap on listings pulled for one search. Hitting it is always
    # disclosed to the user as a partial result — never silently truncated.
    max_listings_per_search: int = 10000
    # Area rents come from the searched area's active rental listings: at most this many pages
    # (500 listings each) per searched location.
    area_rent_max_pages: int = 6
    # ZIP codes whose rental-listing sample is too thin fall back to the provider's market
    # statistics endpoint (one paid request per ZIP), for at most this many ZIPs per search.
    market_stats_fallback_max: int = 3
    # Property-level (paid) rent estimates requested automatically for the top N candidates of
    # each search. 0 = only when a property's analysis page is opened (cheapest).
    rent_avm_top_n: int = 0
    # After the top candidates are upgraded the ranking is re-checked; if unverified properties
    # have moved into the top N they are upgraded too, for at most this many rounds
    # (so at most rent_avm_top_n × rent_avm_max_rounds paid rent estimates per search).
    rent_avm_max_rounds: int = 2
    str_estimate_top_n: int = 5
    search_concurrency: int = 8
    # Run search jobs inside the API process (asyncio task) instead of the
    # Redis-backed worker. Handy for local development without a worker.
    jobs_inline: bool = False

    # --- Badges ------------------------------------------------------------
    high_yield_threshold_pct: Decimal = Decimal("8")
    below_market_threshold_pct: Decimal = Decimal("5")

    # --- Notifications -------------------------------------------------------
    alerts_enabled: bool = True
    alerts_interval_minutes: int = 360
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str | None = None
    public_app_url: str = "http://localhost:3000"

    @field_validator("cors_origins", "admin_emails", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip().startswith("["):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalise_database_url(cls, value: object) -> object:
        """Accept the plain ``postgres://`` / ``postgresql://`` URLs that managed hosts hand out."""
        if isinstance(value, str):
            for prefix in ("postgres://", "postgresql://"):
                if value.startswith(prefix):
                    value = "postgresql+asyncpg://" + value[len(prefix) :]
            # asyncpg spells the libpq ``sslmode`` parameter ``ssl``.
            value = value.replace("?sslmode=", "?ssl=").replace("&sslmode=", "&ssl=")
        return value

    @field_validator("rentcast_api_key", "airdna_api_key", "mapbox_access_token", "anthropic_api_key", "stripe_secret_key", "stripe_webhook_secret", "stripe_price_pro", "stripe_price_premium", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    # --- Derived -----------------------------------------------------------
    @property
    def effective_data_mode(self) -> Literal["demo", "live"]:
        if self.data_mode == "demo":
            return "demo"
        if self.data_mode == "live":
            return "live"
        return "live" if self.rentcast_api_key else "demo"

    @property
    def llm_enabled(self) -> bool:
        return self.llm_provider == "anthropic" and self.anthropic_api_key is not None

    def validate_for_production(self) -> None:
        """Refuse to boot in production with unsafe placeholder secrets."""
        if self.environment != "production":
            return
        problems: list[str] = []
        if self.secret_key.get_secret_value() == _DEV_SECRET or len(self.secret_key.get_secret_value()) < 32:
            problems.append("SECRET_KEY must be set to a random value of at least 32 characters")
        if not self.session_cookie_secure:
            problems.append("SESSION_COOKIE_SECURE must be true in production")
        if self.data_mode == "live" and not self.rentcast_api_key:
            problems.append("DATA_MODE=live requires RENTCAST_API_KEY")
        if problems:
            raise RuntimeError("Invalid production configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
