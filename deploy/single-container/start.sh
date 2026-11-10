#!/bin/sh
# Runs the API (private, localhost) and the web UI (public, $PORT) in one container.
# If either process stops, the script exits non-zero so the platform restarts the container.
set -eu

APP_ROOT="${APP_ROOT:-/app}"
API_PORT="${API_PORT:-8000}"

cd "$APP_ROOT/backend"
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[start] applying database migrations"
  alembic upgrade head
fi

echo "[start] starting API on 127.0.0.1:$API_PORT"
uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" --workers "${WEB_CONCURRENCY:-1}" &
API_PID=$!

cd "$APP_ROOT/web"
echo "[start] starting web UI on 0.0.0.0:${PORT:-3000}"
BACKEND_URL="http://127.0.0.1:$API_PORT" HOSTNAME=0.0.0.0 PORT="${PORT:-3000}" node server.js &
WEB_PID=$!

stop() {
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 2
done

echo "[start] a process exited; stopping the container"
stop
exit 1
