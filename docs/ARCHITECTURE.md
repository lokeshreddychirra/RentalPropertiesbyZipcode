# Architecture

```
Browser ──HTTPS──▶ web (Next.js)
                     │  /api/v1/*  same-origin proxy (session cookie stays first-party)
                     ▼
                   api (FastAPI) ───────────────▶ PostgreSQL + PostGIS   (listings, estimates, users)
                     │        │
                     │        └─ enqueue ─▶ Redis ◀─ dequeue ─ worker (arq)
                     │                       ▲                   │  search jobs, alert checks
                     │    cache · job state · rate limits · usage counters
                     ▼                                           ▼
              provider adapters  ── RentCast · AirDNA · Mapbox · Anthropic · demo dataset
```

## Components

| Path | Responsibility |
|---|---|
| `backend/app/finance/` | Pure, deterministic financial engine (`Decimal`): mortgage, long/short-term models, forecasts, scenarios, sensitivity, data-quality rules, investment score, recommendation. No I/O. |
| `backend/app/providers/` | Adapters behind neutral interfaces (`base.py`), shared HTTP client with rate limiting / retries / budgets (`http.py`), usage accounting (`usage.py`), provider selection (`registry.py`). |
| `backend/app/services/` | `search.py` staged pipeline · `analysis.py` assumption building + provenance · `property_store.py` persistence · `dedupe.py` cross-provider merge · `nl_search.py` · `ai_analyst.py` · `llm.py` · `alerts.py` · `jobs.py` |
| `backend/app/api/v1/` | Versioned REST routers with explicit request/response schemas |
| `backend/app/workers/` | arq worker: search jobs and the alert cron |
| `backend/app/models/` | SQLAlchemy models; migrations in `backend/alembic/` |
| `frontend/src/app/` | Next.js App Router pages and the API proxy route |
| `frontend/src/components/` | UI primitives (shadcn/ui style), search, map and property-analysis components |
| `frontend/src/lib/` | Typed API client (`api-types.ts` is generated from the backend's OpenAPI schema), app state, filter helpers |
| `infra/azure/` | Bicep template for Azure Container Apps |

## Search pipeline

`services/search.py::execute_search` — run by the worker, with progress published to Redis and
polled by the UI.

1. **Resolve** locations into provider queries. Geocoding is only used when a radius or county
   needs it; anything that cannot be honoured produces a user-visible warning.
2. **Fetch** every page of matching listings from each listing provider (pages cached in
   Redis). Budget exhaustion, rate limits, provider errors and the safety cap are recorded as
   `partial_reasons`.
3. **Deduplicate** across providers by normalised address and upsert into PostgreSQL.
4. **Screen** on listing facts (active status, price, beds, type, HOA, days on market, county,
   drawn polygon) — no provider calls.
5. **Area rents:** one market-statistics call per ZIP gives a median rent per bedroom count, so
   every candidate gets a first-pass return at very low cost (labelled as ZIP-level, low confidence).
6. **Upgrade the best candidates:** property-level rent and STR estimates are requested only
   for the top-N by first-pass score, within the remaining budget.
7. **Rank:** the deterministic engine analyses every candidate; cards are stored as a snapshot.

Sorting, return-threshold filters, viewport and polygon filters are applied to the snapshot at
read time, so changing sort order or panning the map never triggers provider calls.

## Analysis flow

`POST /api/v1/analysis/calculate` loads the property context (listing facts + freshest
estimates + STR legality), merges assumptions by precedence, and runs the engine. The response
contains the resolved assumptions, a provenance map, both strategies, data-quality assessments,
score breakdowns, the recommendation, badges and — on request — forecasts, scenarios,
sensitivity tables and financing comparisons. The UI sends only the fields the user changed and
re-requests on every edit (debounced), so there is exactly one implementation of every formula.

## AI usage

The LLM has two narrow jobs and no authority over numbers:

* **Natural-language search** → a strict schema, re-validated by the same `SearchFilters`
  model as the form. Unsupported criteria are returned to the user with reasons.
* **Property explanation** → the model receives a facts sheet built only from engine output
  and sourced data. Every number in its response is checked against that sheet; any
  untraceable figure causes the response to be discarded in favour of a deterministic
  rule-based summary. Both engines return the same structure, and the UI states which one ran.

User-supplied text is passed to the model as delimited data, and model output is rendered as
plain text.

## Data model

`properties` (PostGIS point, dedupe key) ─ `property_listings` (canonical listing) ─
`property_listing_sources` (one per provider record) · `property_images` ·
`property_price_history` · `property_expenses` · `rent_estimates` ─ `rental_comparables` ·
`value_estimates` ─ `sale_comparables` · `short_term_rental_estimates` · `str_regulations` ·
`market_snapshots` · `users` ─ `user_preferences` · `saved_searches` · `favorite_properties` ·
`watchlists` · `financing_scenarios` · `investment_analyses` · `notifications` · `providers` ─
`provider_api_usage`.

Property ids are UUIDv5 of the normalised address, so re-fetching a listing always updates the
same row regardless of provider.

## Security

* Secrets only from environment / secret manager; production refuses to boot with the
  development `SECRET_KEY` or without secure cookies.
* Passwords hashed with Argon2id. Sessions are signed JWTs in an `HttpOnly`, `SameSite=Lax`
  cookie (plus `Secure` in production); Bearer tokens are also accepted for API clients.
* The browser only calls the Next.js origin; the API has internal ingress in the Azure template.
* All request bodies and query parameters are validated by Pydantic schemas (bounds on every
  numeric input, `extra="forbid"` on assumptions and filters). SQL goes through SQLAlchemy
  with bound parameters.
* Per-IP rate limits on auth, search, natural-language and AI endpoints; provider budgets cap spend.
* Budget and STR-registry changes require the administrator role; user data is always filtered
  by owner.
* CSV export neutralises spreadsheet formulas; external links use `rel="noopener noreferrer"`.
* Structured errors never include stack traces or provider credentials.

Rate limiting keys on the first `X-Forwarded-For` address. Deploy behind an ingress that sets
that header (Azure Container Apps does); if you expose the API differently, make sure clients
cannot spoof it.

## Scaling notes

* `web` and `api` are stateless and scale horizontally; job state, caches and counters live in Redis.
* Search work runs in workers (`max_jobs` per replica), so slow provider calls never tie up API replicas.
* Result snapshots are held in Redis for six hours; very large result sets (tens of thousands
  of listings per search) would be better served from a materialised table — the read path is
  isolated in `page_results` / `map_points` to make that change local.
