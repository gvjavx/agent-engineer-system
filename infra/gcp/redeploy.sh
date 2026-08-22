#!/usr/bin/env bash
# Run on the VM (as root) by the GitHub Actions deploy workflow after every
# push to main: pull the new code, refresh secrets in case they changed, and
# rebuild. Also handy to run by hand over SSH after editing the env secret
# directly, without waiting for a push.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

git pull --ff-only origin main

meta() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
PROJECT_ID="$(meta project-id)"
SECRET_NAME="$(meta secret-name)"
TOKEN="$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" | \
  grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)"
curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest:access" | \
  grep -o '"data":"[^"]*"' | cut -d'"' -f4 | base64 -d > .env
chmod 600 .env

docker compose -f infra/docker-compose.yml up -d --build
docker image prune -f
