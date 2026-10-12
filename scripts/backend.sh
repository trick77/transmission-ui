#!/usr/bin/env bash
# Build and start the backend against the local compose daemon, in form mode
# (no identity provider needed). Used by ui/e2e/backend.spec.ts and handy for
# driving the real shipped path by hand.
#
#   scripts/backend.sh            start on :8127, write the pid to scripts/backend.pid
#   scripts/backend.sh stop       stop it
#
# The daemon must already be up: docker compose -f compose.dev.yaml up -d
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${TM_APP_PORT:-8127}"
PIDFILE="$ROOT/scripts/backend.pid"

if [[ "${1:-start}" == "stop" ]]; then
  if [[ -f "$PIDFILE" ]]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  exit 0
fi

# main.go embeds the bundle vite builds into backend/dist, so it must exist before the build.
[[ -f "$ROOT/backend/dist/index.html" ]] || { echo "backend/dist has no bundle; run make fe-build first" >&2; exit 1; }

go build -C "$ROOT/backend" -o "$ROOT/scripts/transmission-ui" .

# BACKEND_PUBLIC_URL is loopback, so the session cookie is not marked Secure:
# Safari drops a Secure cookie on plain http and the sign-in would loop.
BACKEND_ADDR="127.0.0.1:$PORT" \
BACKEND_AUTH_MODE=form \
BACKEND_PUBLIC_URL="http://127.0.0.1:$PORT" \
BACKEND_SESSION_SECRET=e2e-only-not-a-real-secret-32-bytes-or-more \
TRANSMISSION_RPC_UPSTREAM="${TRANSMISSION_RPC_UPSTREAM:-http://127.0.0.1:9091}" \
TRANSMISSION_USER="${TRANSMISSION_USER:-dev}" \
TRANSMISSION_PASSWORD="${TRANSMISSION_PASSWORD:-devpass}" \
  "$ROOT/scripts/transmission-ui" > "$ROOT/scripts/backend.log" 2>&1 &
echo $! > "$PIDFILE"

# Wait for the listener rather than sleeping a fixed amount.
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
    echo "backend on http://127.0.0.1:$PORT (form mode, $(cat "$PIDFILE"))"
    exit 0
  fi
  sleep 0.2
done

echo "backend did not come up; see scripts/backend.log" >&2
cat "$ROOT/scripts/backend.log" >&2
exit 1
