#!/usr/bin/env bash
# Runs both services locally, exposes the whatsapp-gateway through an ngrok
# tunnel, and automatically re-applies the Meta webhook field subscription
# for the fresh tunnel URL (see scripts/fix-whatsapp-webhook.sh — Meta resets
# subscribed fields like "messages" every time the Callback URL changes).
#
# Requires ngrok installed and authenticated
# (https://dashboard.ngrok.com/get-started/your-authtoken -> `ngrok config
# add-authtoken <token>`), and a filled-in .env at the repo root (including
# META_APP_ID and META_WABA_ID — see .env.example).
#
# Usage: ./scripts/dev-tunnel.sh
# Stop with Ctrl+C — this also stops the two dev servers and ngrok.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok not found. Install it first: https://ngrok.com/download" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo ".env not found at repo root. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

pids=()
cleanup() {
  echo ""
  echo "Stopping dev servers and ngrok..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "Starting orchestrator (logs: /tmp/orchestrator-dev.log)..."
npm run dev --workspace apps/orchestrator > /tmp/orchestrator-dev.log 2>&1 &
pids+=($!)

echo "Starting whatsapp-gateway (logs: /tmp/whatsapp-gateway-dev.log)..."
npm run dev --workspace apps/whatsapp-gateway > /tmp/whatsapp-gateway-dev.log 2>&1 &
pids+=($!)

echo "Starting ngrok tunnel to port 3000 (logs: /tmp/ngrok-dev.log)..."
ngrok http 3000 --log=stdout > /tmp/ngrok-dev.log 2>&1 &
pids+=($!)

echo "Waiting for ngrok's public URL..."
public_url=""
# Matched on target port, not tunnels[0] — :4040's API can be shared with
# another ngrok agent already running on this machine for something
# unrelated, in which case tunnels[0] may not be the one this script just
# started (see the same fix in fix-whatsapp-webhook.sh for the incident that
# prompted this).
for _ in $(seq 1 20); do
  public_url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e "
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => {
      try {
        const tunnels = JSON.parse(d).tunnels || [];
        const match = tunnels.find((t) => {
          try { return t.proto === 'https' && new URL(t.config.addr).port === '3000'; } catch { return false; }
        });
        if (!match) process.exit(1);
        console.log(match.public_url);
      } catch { process.exit(1); }
    });" 2>/dev/null) && [ -n "$public_url" ] && break
  sleep 1
done

if [ -z "$public_url" ]; then
  echo "ngrok didn't come up in time (or another ngrok agent on this machine is holding :4040" >&2
  echo "and this tunnel never showed up there) — check /tmp/ngrok-dev.log" >&2
  exit 1
fi

echo ""
echo "Public URL: $public_url"
echo "Webhook Callback URL for Meta: ${public_url}/webhook"
echo ""

if ./scripts/fix-whatsapp-webhook.sh "$public_url"; then
  echo ""
  echo "Webhook subscription applied automatically — no manual Meta dashboard step needed."
else
  echo ""
  echo "Auto-fix failed (see above). You may need to set the Callback URL manually in" >&2
  echo "Meta App Dashboard > WhatsApp > Configuration: ${public_url}/webhook" >&2
fi

echo ""
echo "Tail logs with:"
echo "  tail -f /tmp/orchestrator-dev.log"
echo "  tail -f /tmp/whatsapp-gateway-dev.log"
echo "  tail -f /tmp/ngrok-dev.log"
echo ""
echo "Press Ctrl+C to stop everything."

wait
