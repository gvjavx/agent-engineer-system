#!/usr/bin/env bash
# Meta has two known gotchas that silently break inbound WhatsApp delivery
# even when everything "looks" configured correctly in the dashboard:
#
# 1. Re-verifying/changing the app's webhook Callback URL (e.g. every time
#    ngrok gives you a new free URL) resets the subscribed *fields* back to
#    just a couple of defaults — "messages" quietly falls off the list, so
#    the webhook is "active" but never actually fires for incoming chats.
# 2. The WhatsApp Business Account (WABA) itself has to explicitly
#    "subscribe" this app via /{WABA_ID}/subscribed_apps. This is usually
#    one-time, but a fresh WABA/app pairing (or Meta's own default demo app
#    being attached instead of yours) can leave it missing.
#
# This script re-applies both, and is safe to run every time you restart the
# tunnel — it's idempotent either way.
#
# Usage:
#   ./scripts/fix-whatsapp-webhook.sh                 # auto-detect ngrok URL
#   ./scripts/fix-whatsapp-webhook.sh https://foo.ngrok-free.app  # explicit URL
#
# Requires in .env: META_APP_ID, META_APP_SECRET, META_VERIFY_TOKEN,
# META_WABA_ID, META_ACCESS_TOKEN, META_GRAPH_API_VERSION.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  echo ".env not found at repo root." >&2
  exit 1
fi
# Loaded via node's dotenv parser rather than bash `source` — .env values
# are allowed to contain spaces/special characters unquoted (e.g.
# GIT_AUTHOR_NAME=AI AES), which `source` mis-parses as shell commands.
eval "$(node -e "
  const dotenv = require('dotenv');
  const { parsed } = dotenv.config({ path: '.env', quiet: true });
  const shQuote = (s) => \"'\" + String(s).replace(/'/g, \"'\\\\''\") + \"'\";
  for (const [k, v] of Object.entries(parsed || {})) {
    console.log('export ' + k + '=' + shQuote(v));
  }
")"

for var in META_APP_ID META_APP_SECRET META_VERIFY_TOKEN META_WABA_ID META_ACCESS_TOKEN META_GRAPH_API_VERSION; do
  if [ -z "${!var:-}" ]; then
    echo "Missing $var in .env — can't fix the webhook subscription without it." >&2
    exit 1
  fi
done

callback_base="${1:-}"
if [ -z "$callback_base" ]; then
  # ngrok's :4040 API can be listing tunnels for other projects too (same
  # ngrok agent, different local ports) — picking tunnels[0] blindly handed
  # Meta whatever tunnel happened to be first, verification 404'd, and it had
  # nothing to do with this repo. Match on the tunnel whose local target port
  # is actually whatsapp-gateway's (PORT in .env, default 3000) instead.
  gateway_port="${PORT:-3000}"
  callback_base=$(curl -s http://127.0.0.1:4040/api/tunnels | node -e "
    const port = process.argv[1];
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => {
      let tunnels;
      try { tunnels = JSON.parse(d).tunnels || []; } catch { process.exit(1); }
      const matches = tunnels.filter((t) => {
        try { return t.proto === 'https' && new URL(t.config.addr).port === port; } catch { return false; }
      });
      if (matches.length === 1) { console.log(matches[0].public_url); return; }
      if (matches.length === 0) {
        console.error('No ngrok tunnel points at localhost:' + port + ' (whatsapp-gateway).');
      } else {
        console.error('Multiple ngrok tunnels point at localhost:' + port + ' — pass the URL explicitly.');
      }
      if (tunnels.length > 0) {
        console.error('Tunnels currently running:');
        for (const t of tunnels) console.error('  ' + t.public_url + ' -> ' + (t.config?.addr ?? '?'));
      }
      process.exit(1);
    });
  " "$gateway_port") || {
    echo "Couldn't auto-detect the ngrok URL for localhost:$gateway_port (see above, or start one: ngrok http $gateway_port)." >&2
    echo "Or pass it explicitly: ./scripts/fix-whatsapp-webhook.sh https://<your-url>.ngrok-free.app" >&2
    exit 1
  }
fi
callback_url="${callback_base%/}/webhook"

echo "Using callback URL: $callback_url"

echo "1/2 Re-applying app webhook field subscription..."
sub_response=$(curl -s -X POST "https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_APP_ID}/subscriptions" \
  --data-urlencode "object=whatsapp_business_account" \
  --data-urlencode "callback_url=${callback_url}" \
  --data-urlencode "verify_token=${META_VERIFY_TOKEN}" \
  --data-urlencode "fields=messages,account_alerts,calls,security,message_template_quality_update,message_template_status_update" \
  --data-urlencode "access_token=${META_APP_ID}|${META_APP_SECRET}")
echo "   $sub_response"

echo "2/2 Making sure the WABA is subscribed to this app..."
waba_response=$(curl -s -X POST "https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_WABA_ID}/subscribed_apps" \
  -H "Authorization: Bearer ${META_ACCESS_TOKEN}")
echo "   $waba_response"

if [[ "$sub_response" == *'"success":true'* ]] && [[ "$waba_response" == *'"success":true'* ]]; then
  echo ""
  echo "Done. Verifying the 'messages' field actually stuck..."
  check=$(curl -s "https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_APP_ID}/subscriptions?access_token=${META_APP_ID}|${META_APP_SECRET}")
  if [[ "$check" == *'"name":"messages"'* ]]; then
    echo "Confirmed — 'messages' is subscribed. Inbound WhatsApp messages should reach $callback_url now."
  else
    echo "Warning: 'messages' still doesn't show up in the subscription list. Response was:" >&2
    echo "$check" >&2
    exit 1
  fi
else
  echo "One of the calls didn't report success — check the responses above." >&2
  exit 1
fi
