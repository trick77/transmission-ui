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
  [[ -f "$PIDFILE" ]] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit 0
fi

# main.go embeds the bundle, so it must exist before the build.
[[ -d "$ROOT/ui/dist" ]] || { echo "ui/dist missing; run npm run build in ui/ first" >&2; exit 1; }
# Mirror, not copy: every UI build emits new hashed names, and a plain copy
# leaves the old bundles behind to be embedded with the new one.
mkdir -p "$ROOT/backend/dist"
rsync -a --delete "$ROOT/ui/dist/" "$ROOT/backend/dist/"

go build -C "$ROOT/backend" -o "$ROOT/scripts/transmission-ui" .

# BACKEND_PUBLIC_URL is loopback, so the session cookie is not marked Secure:
# Safari drops a Secure cookie on plain http and the sign-in would loop.
BACKEND_ADDR="127.0.0.1:$PORT" \
BACKEND_AUTH_MODE=form \
BACKEND_PUBLIC_URL="http://127.0.0.1:$PORT" \
BACKEND_SESSION_SECRET=e2e-only-not-a-real-secret \
TM_RPC_UPSTREAM="${TM_RPC_UPSTREAM:-http://127.0.0.1:9091}" \
TM_USER="${TM_USER:-dev}" \
TM_PASS="${TM_PASS:-devpass}" \
  "$ROOT/scripts/transmission-ui" > "$ROOT/scripts/backend.log" 2>&1 &
echo $! > "$PIDFILE"

# Wait for the listener rather than sleeping a fixed amount.
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login"; then
    echo "backend on http://127.0.0.1:$PORT (form mode, $(cat "$PIDFILE"))"
    exit 0
  fi
  sleep 0.2
done

echo "backend did not come up; see scripts/backend.log" >&2
cat "$ROOT/scripts/backend.log" >&2
exit 1
