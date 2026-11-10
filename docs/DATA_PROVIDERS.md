# Data providers and activating live data

PropertyYield AI talks to external data sources only through adapters
(`backend/app/providers/`). Each adapter returns provider-neutral records, so the rest of the
application never depends on a vendor's response format.

| Provider | Used for | Adapter | Required? |
|---|---|---|---|
| RentCast | Active for-sale listings, long-term rent AVM + comparables, value AVM + sale comparables, ZIP market statistics, tax records | `rentcast.py` | Yes, for live mode |
| AirDNA | Short-term rental ADR, occupancy, revenue, seasonality | `airdna.py` | Optional |
| Mapbox | Geocoding for radius / county searches (server), base map (browser) | `mapbox.py` | Optional |
| Anthropic Claude | AI property analysis, natural-language search parsing | `services/llm.py` | Optional |
| Demo dataset | Synthetic listings, estimates and market data | `demo.py` | Built in |

## Demo mode

With no `RENTCAST_API_KEY` (or `DATA_MODE=demo`) the app runs on a deterministic synthetic
dataset covering 34 ZIP codes in 18 US cities.

* Every demo record is flagged `is_demo` in the API and labelled **DEMO** in the UI; a banner
  is shown on every page. Demo listings have no "original listing" link.
* Addresses are fabricated ("1423 Sample Oak St"), and price/rent levels are only rough
  approximations. Demo STR legality statuses are illustrative, not legal determinations.
* Demo data flows through exactly the same pipeline as live data (pagination, dedupe,
  screening, ranking), so behaviour is representative.

Demo records are flagged in the database, and a search only ever returns what the active
providers supplied, so demo and live listings are never mixed in search results.

## Activating live data

1. **RentCast** — create a key at <https://app.rentcast.io/app/api> and set `RENTCAST_API_KEY`
   on the `api` and `worker` services. Leave `DATA_MODE=auto` (or set `live` to fail fast if the
   key is missing).
2. **Budgets** — set `RENTCAST_MONTHLY_REQUEST_BUDGET` / `RENTCAST_MONTHLY_COST_BUDGET_USD`
   and `RENTCAST_COST_PER_REQUEST_USD` to match your plan. They can be changed later by an
   administrator under Settings → API usage & budgets.
3. Optional keys: `AIRDNA_API_KEY`, `MAPBOX_ACCESS_TOKEN` (server geocoding),
   `MAPBOX_PUBLIC_TOKEN` (browser map, `pk.…`), `ANTHROPIC_API_KEY`.
4. Restart the services. `GET /api/v1/system/status` (and Settings → Data sources) shows what
   is connected.

Secrets are read from environment variables only. Use your platform's secret manager in
production; nothing is ever stored in the browser or the repository.

### What each missing key means

| Missing | Behaviour |
|---|---|
| AirDNA | Short-term revenue is **unavailable** unless the user enters a nightly rate and occupancy. It is never guessed. |
| Mapbox (server) | Radius searches fall back to the named city/ZIP and county searches scan the state — both with a visible warning. |
| Mapbox (browser) | The map uses an OpenStreetMap raster base map. Fine for development; use Mapbox in production (OSM's tile servers are not for production traffic). |
| Anthropic | AI analysis uses the deterministic rule-based summary; natural-language search uses the rule-based parser. |

## RentCast notes

* Endpoints used: `GET /listings/sale`, `/avm/rent/long-term`, `/avm/value`, `/markets`,
  `/properties`. Authentication is the `X-Api-Key` header.
* **Pagination:** `limit` (max 500) + `offset`; the adapter pages until a short page is
  returned. A search never stops at the first page.
* RentCast sale listings do **not** include photos, marketing descriptions or a link to the
  originating listing site. Those fields stay empty: cards show a neutral illustration labelled
  as such, and "Open original listing" is disabled with an explanation. The MLS name and number
  are shown so the listing can be looked up.
* Only listings with `status = Active` are treated as for sale, and the listing's last-seen
  date drives the freshness score.
* `RENTCAST_RANGE_FILTERS=true` pushes price/bedroom ranges to the API using `min:max`
  syntax. Leave it off unless your API version supports it; filters are then applied locally.
* Review RentCast's terms for your plan regarding caching, redistribution and attribution.
  The app displays "Listing and rent data provided by RentCast" on property pages.

**Requests per search.** One search uses roughly: 1 request per 500 listings per location,
1 market-statistics request per ZIP code found (cached for `MARKET_STATS_TTL_DAYS`), and up to
`RENT_AVM_TOP_N` × `RENT_AVM_MAX_ROUNDS` (default 2) rent-estimate requests — fewer when the
top-ranked properties already have fresh estimates. Vacant land listings are excluded unless
the Land property type is requested. Opening a property's analysis page requests its rent
estimate if it has none. On a small plan, lower `RENT_AVM_TOP_N` and set the monthly request
limit under Settings → API usage & budgets to your plan's quota (the first account registered
is the administrator). Budget environment variables only seed the initial values; after first
start they are managed in Settings.

**Inactive subscription.** RentCast answers `403 billing/subscription-inactive` until an API
plan is activated at <https://app.rentcast.io/app/api>. The app reports that message on the
search instead of returning results.

> The adapter has been run against the live RentCast API (sale listings, rent and value
> estimates, market statistics and property records) and a full live search was completed
> end to end. It is also covered by tests using recorded-shape fixtures.

## AirDNA notes

AirDNA's API requires an enterprise agreement and its request/response contract depends on
your contract and API version. The adapter therefore:

* keeps the base URL configurable (`AIRDNA_BASE_URL`);
* isolates the vendor mapping in two functions, `build_request` and `parse_estimate`
  (`backend/app/providers/airdna.py`) — **confirm both against the documentation supplied with
  your contract before relying on it**;
* returns "unavailable" whenever a usable ADR and occupancy are not present.

AirDNA reports ADR inclusive of cleaning fees and occupancy over available nights; both facts
are carried into the financial model so cleaning income is not double-counted.

## Short-term rental legality

There is no authoritative national API for local STR rules, so the app does not pretend to
have one:

* Default status for every live location is **Unknown / needs verification**.
* An administrator records verified rules under Settings → STR regulation registry
  (`PUT /api/v1/system/str-regulations`) by ZIP, city, county or state. A source URL and
  verification date are mandatory. The most specific match wins.
* A recorded night cap is applied to the STR revenue model automatically.
* Legality is never inferred from nearby short-term rental listings.

## Cost controls

| Mechanism | Detail |
|---|---|
| Staged retrieval | Listings (paginated) → free local filters → one `/markets` call per ZIP for conservative area rents → property-level AVM only for the top `RENT_AVM_TOP_N` candidates (re-checked for `RENT_AVM_MAX_ROUNDS` rounds) → STR estimates only for the top `STR_ESTIMATE_TOP_N` or on demand |
| Caching | Listing pages in Redis (`LISTING_CACHE_TTL_SECONDS`), estimates and market stats in PostgreSQL with freshness thresholds (`*_TTL_DAYS`), identical searches served from cache |
| Budgets | Monthly request and cost limits per provider, enforced before every call |
| Disclosure | Hitting a budget, rate limit, provider error or `MAX_LISTINGS_PER_SEARCH` marks the search **partial** with the reason shown to the user |
| Accounting | Every call is recorded (`provider_api_usage`); Settings shows requests, errors and estimated cost |
| Rate limits | Client-side pacing per provider, retries with backoff, `Retry-After` honoured |

## Adding another listing source (MLS / RESO Web API)

1. Implement `ListingProvider` (`providers/base.py`): `search_listings(query, offset, limit)`
   returning `ListingPage` of `ListingRecord`.
2. Add it to `listing_providers` in `providers/registry.py`.
3. Add a row to `PROVIDER_SPECS` (`providers/usage.py`) with its attribution text.

Listings from several providers are merged by normalised address (street, unit, ZIP): the
freshest active record leads, missing fields are filled from the others, and every source is
kept in `property_listing_sources`. Respect each feed's display, image and attribution rules —
`ListingRecord.image_attribution` is shown under photos.
