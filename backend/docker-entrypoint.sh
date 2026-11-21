#!/bin/sh
# One image, three roles: api | worker | migrate
set -eu

role="${1:-api}"

case "$role" in
  api)
    # RUN_MIGRATIONS=true applies pending migrations before starting (handy for
    # single-replica and local setups; use the "migrate" job for multi-replica deploys).
    if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
      alembic upgrade head
    fi
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers "${WEB_CONCURRENCY:-2}" --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}"
    ;;
  worker)
    exec arq app.workers.main.WorkerSettings
    ;;
  migrate)
    exec alembic upgrade head
    ;;
  *)
    exec "$@"
    ;;
esac
