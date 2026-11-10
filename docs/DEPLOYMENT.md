# Deployment

Two container images run the whole application:

| Image | Built from | Roles |
|---|---|---|
| `propertyyield-api` | `backend/Dockerfile` | `api` (default), `worker`, `migrate` — selected by the container argument |
| `propertyyield-web` | `frontend/Dockerfile` | Next.js UI and same-origin API proxy |

Both are configured entirely by environment variables at runtime (see `.env.example`), so the
same images run locally, on Azure, or on any other container platform.

## Local: Docker Compose

```bash
cp .env.example .env
# set SECRET_KEY and POSTGRES_PASSWORD (and API keys if you have them)
docker compose up --build
```

* Web UI: <http://localhost:3000> · API docs: <http://localhost:8000/api/docs>
* Services: `db` (PostGIS), `redis`, `migrate` (runs once), `api`, `worker`, `web`.
* With no `RENTCAST_API_KEY` the stack starts in demo mode.

## Local: without Docker

Requirements: Python 3.12+, Node 22+, PostgreSQL 16 with PostGIS, Redis 7.

```bash
# database (once)
createuser propertyyield --pwprompt && createdb propertyyield -O propertyyield
psql -d propertyyield -c 'CREATE EXTENSION IF NOT EXISTS postgis'      # as a superuser

# backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cat > .env <<'EOF'
DATABASE_URL=postgresql+asyncpg://propertyyield:<password>@localhost:5432/propertyyield
JOBS_INLINE=true
EOF
alembic upgrade head
uvicorn app.main:app --reload --port 8000
# optional separate worker (set JOBS_INLINE=false):  arq app.workers.main.WorkerSettings

# frontend
cd ../frontend
npm ci
BACKEND_URL=http://localhost:8000 npm run dev
```

`JOBS_INLINE=true` runs search jobs inside the API process, which is convenient for development.
Scheduled alert checks only run in the worker.

### Tests and checks

```bash
cd backend && pytest            # API tests need PostgreSQL+PostGIS and Redis (TEST_DATABASE_URL / TEST_REDIS_URL)
cd backend && ruff check app tests
cd frontend && npm run typecheck && npm run lint && npm run build
cd frontend && npm run gen:api  # regenerate TypeScript types after changing backend schemas
```

## Azure Container Apps

`infra/azure/main.bicep` provisions Log Analytics, a Container Apps environment, PostgreSQL
Flexible Server (PostGIS allow-listed), Azure Cache for Redis, a managed identity for registry
pulls, the `web` / `api` / `worker` apps and a manual `migrate` job.

```bash
RG=propertyyield-rg; ACR=<your-acr-name>; TAG=$(git rev-parse --short HEAD)

az group create -n $RG -l eastus2
az acr create -g $RG -n $ACR --sku Basic

# build and push
az acr build -r $ACR -t propertyyield-api:$TAG backend
az acr build -r $ACR -t propertyyield-web:$TAG frontend

# deploy (keep secrets in Key Vault — see main.parameters.example.json)
cp infra/azure/main.parameters.example.json infra/azure/main.parameters.json   # git-ignored
az deployment group create -g $RG -f infra/azure/main.bicep -p infra/azure/main.parameters.json \
  -p apiImageTag=$TAG webImageTag=$TAG

# apply migrations, then open the app
az containerapp job start -g $RG -n propertyyield-migrate
az deployment group show -g $RG -n main --query properties.outputs.webUrl.value -o tsv
```

For each release: build and push new tags, start the `migrate` job, then redeploy with the new
tags. Write migrations to be backward compatible with the previous release so the job can run
before the apps roll.

Notes on the template:

* The API has **internal** ingress; only `web` is public. TLS terminates at the Container Apps ingress.
* PostgreSQL and Redis are reachable from Azure services over TLS. For production, move both
  behind VNet integration / private endpoints and enable zone redundancy and geo-backups as your
  requirements dictate.
* Application secrets are Container Apps secrets supplied as secure parameters. To rotate
  without redeploying, switch them to Key Vault references with the app's managed identity.
* The PostgreSQL admin password is embedded in the connection URL — use URL-safe characters.
* One worker replica is kept running so the alert cron always fires.

> The Bicep template has not been deployed from the environment this project was built in
> (no Azure access). Run `az deployment group what-if` first and expect to adjust SKUs,
> regions and API versions to your subscription.

## Other platforms

Nothing in the application is Azure-specific. Provide:

| Need | Any equivalent |
|---|---|
| PostgreSQL 14+ with PostGIS | RDS / Cloud SQL / Neon / self-hosted |
| Redis 6+ | ElastiCache / Memorystore / Upstash / self-hosted |
| Three long-running containers | `web`, `api`, `worker` (ECS, Cloud Run + a worker pool, Kubernetes, Fly, Render…) |
| One-off job | `migrate` before each rollout |
| Secrets | the variables in `.env.example` |

`DATABASE_URL` uses the `postgresql+asyncpg://` scheme (append `?ssl=require` for managed
databases); `REDIS_URL` accepts `redis://` and `rediss://`.

## Production checklist

- [ ] `ENVIRONMENT=production`, a random `SECRET_KEY` (≥ 32 chars), `SESSION_COOKIE_SECURE=true`
- [ ] `PUBLIC_APP_URL` and `CORS_ORIGINS` set to the public origin
- [ ] Provider budgets set to match your plans; `ADMIN_EMAILS` set
- [ ] `MAPBOX_PUBLIC_TOKEN` restricted to your domain
- [ ] Database backups and Redis persistence policy chosen (Redis holds only caches and job state)
- [ ] Log shipping and alerts on `/readyz`, provider error rate and budget usage
- [ ] Provider terms reviewed for caching, display and attribution requirements
- [ ] STR regulation registry populated for the markets you care about
