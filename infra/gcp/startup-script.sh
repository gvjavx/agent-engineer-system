#!/usr/bin/env bash
# GCE startup-script (runs as root on every boot). First boot: installs
# Docker, clones the repo, and brings the stack up. Later boots: the repo's
# already there, so this just makes sure it's running.
set -euo pipefail

meta() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
PROJECT_ID="$(meta project-id)"
SECRET_NAME="$(meta secret-name)"
GITHUB_REPO="$(meta github-repo)"
REPO_DIR=/opt/agent-engineer-system

if ! command -v docker &>/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends docker.io docker-compose-v2 git curl
  systemctl enable --now docker
fi

fetch_env() {
  local token
  token="$(curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" | \
    grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)"
  curl -sf -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest:access" | \
    grep -o '"data":"[^"]*"' | cut -d'"' -f4 | base64 -d
}

if [ ! -d "$REPO_DIR/.git" ]; then
  fetch_env > /tmp/agent-engineer.env
  GITHUB_TOKEN="$(grep '^GITHUB_TOKEN=' /tmp/agent-engineer.env | cut -d= -f2-)"
  git clone "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" "$REPO_DIR"
  mv /tmp/agent-engineer.env "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
else
  fetch_env > "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
fi

cd "$REPO_DIR"
docker compose -f infra/docker-compose.yml up -d --build
