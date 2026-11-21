# syntax=docker/dockerfile:1
#
# Single-container image: the Next.js UI and the FastAPI backend in one container.
# Intended for small / free-tier hosts (see render.yaml) where one service is simpler
# and cheaper than three. Build context is the repository root:
#
#   docker build -f deploy/single-container/Dockerfile -t propertyyield .
#
# Search jobs run inside the API process (JOBS_INLINE=true), so there is no separate
# worker and scheduled alert checks do not run. For production use the split images
# (backend/Dockerfile, frontend/Dockerfile) with a worker.

FROM node:22-slim AS web-build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS run
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    JOBS_INLINE=true

# Node.js runtime for the Next.js standalone server
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node

WORKDIR /app/backend
COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install .
COPY backend/alembic.ini ./
COPY backend/alembic ./alembic

WORKDIR /app/web
COPY --from=web-build /src/.next/standalone ./
COPY --from=web-build /src/.next/static ./.next/static
COPY --from=web-build /src/public ./public

COPY deploy/single-container/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh \
    && useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# The platform provides PORT; the UI listens on it and proxies /api/v1 to the API on localhost.
EXPOSE 3000
CMD ["start.sh"]
