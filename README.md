# PropertyYield AI

Find US residential investment properties with the strongest rental yield, cash flow,
cash-on-cash return and risk-adjusted profitability. Every listing is analysed as a
**long-term rental** (short-term rentals are not offered), and results are ranked by
calculated returns — not by price or estimated rent.

> **Estimates, not advice.** All figures are estimates from third-party data and user
> assumptions. Verify listings, rents and taxes independently.

## What it does

* **Search** by ZIP code (accounts required; Free / Pro / Premium plans meter usage — see
  [docs/PLANS.md](docs/PLANS.md)), with price, bedroom,
  property-type, HOA and days-on-market filters plus return thresholds (gross/net yield, cap
  rate, cash-on-cash, cash flow).
* **Rank** every match with a deterministic financial engine and a configurable 0–100
  investment score; sort by ten return metrics. List, map, map + list and comparison-table views.
* **Analyse** a property in depth: a deal simulator (sliders for price, down payment, rate and rent that update returns as you drag),
  expense breakdown, mortgage, 1–30 year forecast, financing
  scenarios, conservative/base/optimistic cases, sensitivity tables, risk and data-quality
  assessment, rent and sale comparables, and a grounded AI explanation.
* **Compare** up to five properties side by side with the best value per metric highlighted;
  export to CSV or PDF.
* **Save** searches, properties, watchlists, financing presets and evaluations (optional
  accounts), with background alerts for new matches, price reductions and return thresholds.
* **Use it anywhere**: on the web, on mobile web (bottom tab bar), installed from the browser
  as an app with an offline page, or as iOS and Android apps built with Capacitor
  ([docs/MOBILE.md](docs/MOBILE.md)).
* **Control cost**: staged retrieval, caching, per-provider budgets, usage tracking, and
  explicit disclosure whenever results are partial.

## Honesty rules built into the product

* Sample data is never presented as live: without API credentials the app runs in a clearly
  labelled **demo mode** (banner on every page, DEMO tag on every record).
* Missing estimates are shown as **unavailable**, never invented.
* Every input is labelled as source data, estimate, default or user-entered, and every analysis
  carries a High / Medium / Low / Insufficient Data confidence label. Weak data caps the score.
* The LLM explains calculated results; it never produces authoritative numbers, and responses
  quoting figures that cannot be traced to calculated values are discarded.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui-style components, Recharts, Mapbox GL (MapLibre fallback) |
| Backend | Python, FastAPI, Pydantic v2, SQLAlchemy 2 (async), Alembic |
| Data | PostgreSQL + PostGIS (data and paid-response cache), Redis (job state, rate limits) |
| Jobs | arq workers on Redis (search jobs, scheduled alert checks) |
| Finance | Pure Python `Decimal` engine |
| Providers | RentCast, AirDNA, Mapbox, Anthropic Claude — all behind adapters |
| Mobile | Installable web app (manifest, service worker); Capacitor 8 iOS and Android apps in `mobile/` |
| Deploy | Docker Compose locally; Render Blueprint; Azure Container Apps (Bicep); provider-independent images |

## Quick start

```bash
cp .env.example .env          # set SECRET_KEY and POSTGRES_PASSWORD
docker compose up --build
```

Open <http://localhost:3000>. With no API keys the app starts in demo mode — try
*Atlanta, GA* or ZIP *30269*. API documentation is at <http://localhost:8000/api/docs>.

To run without Docker, or to get a public URL quickly with the included Render Blueprint
(`render.yaml`), see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Going live

Set `RENTCAST_API_KEY` (required for live listings) and optionally `AIRDNA_API_KEY`,
`MAPBOX_ACCESS_TOKEN` / `MAPBOX_PUBLIC_TOKEN` and `ANTHROPIC_API_KEY`, then restart. Details,
provider caveats and cost controls: [docs/DATA_PROVIDERS.md](docs/DATA_PROVIDERS.md).

The first account registered on a new installation is the administrator (budgets, STR
regulation registry).

## Documentation

| Document | Contents |
|---|---|
| [docs/FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md) | Every formula, default assumption, the scoring method, confidence-label rules, badge rules |
| [docs/DATA_PROVIDERS.md](docs/DATA_PROVIDERS.md) | Demo vs live mode, activating providers, what each provider does and does not supply, budgets, adding an MLS feed |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, search pipeline, AI grounding, data model, security |
| [docs/PLANS.md](docs/PLANS.md) | Plans, quotas, pricing rationale, Stripe setup, admin user management |
| [docs/MOBILE.md](docs/MOBILE.md) | Mobile web, installing as an app, building the iOS and Android apps, publishing to the App Store and Google Play |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker Compose, local setup, Azure Container Apps, other platforms, production checklist |

## API

Versioned REST under `/api/v1` with OpenAPI docs. Main routes:

```
GET  /properties/search                     search + rank in one blocking call
POST /searches/run                          start a background search job
GET  /searches/jobs/{id}                    progress, partial flags, warnings
GET  /searches/jobs/{id}/results            sorted, paginated cards (bbox / polygon filters)
GET  /searches/jobs/{id}/map                points for the map
POST /searches/parse                        natural language → filters
GET  /properties/{id}                       listing details, history, sources
GET  /properties/{id}/rent-estimate         rent estimate + comparables
GET  /properties/{id}/str-estimate          short-term rental estimate
GET  /properties/{id}/value-estimate        value estimate + sale comparables
POST /analysis/calculate                    full financial model with overrides
POST /analysis/compare                      up to five properties
POST /analysis/scenarios                    scenarios + sensitivity
POST /analysis/ai-explanation               grounded explanation
GET  /market/summary                        ZIP-level market statistics
POST /searches/save · GET /searches/saved   saved searches and alerts
GET  /favorites · /watchlists · /notifications
GET  /system/status · /system/usage · PUT /system/budgets/{provider}
```

Errors have the shape `{"error": {"code", "message", "details"}}`.

## Development

```bash
cd backend && pytest                                              # 91 tests
cd frontend && npm run typecheck && npm run lint && npm run build
```

The financial engine tests use hand-computed expected values; API tests run the full pipeline
against PostgreSQL and Redis in demo mode; provider tests cover pagination, retries, budget
exhaustion and parsing with stubbed HTTP.

## Known limitations

* The RentCast and Mapbox integrations have been run against the live services. The AirDNA
  and Anthropic integrations have only been tested with stubbed responses; the AirDNA mapping
  in particular must be confirmed against your contract.
* RentCast does not supply listing photos, descriptions or links to the original listing page,
  so those are unavailable in RentCast-only deployments.
* The model is pre-tax and does not predict property-tax reassessment after a sale.
* The Azure template and the Render Blueprint have not been deployed from the build
  environment — treat the first deploy as the test (`what-if` first on Azure).
