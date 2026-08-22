#!/usr/bin/env bash
# Runs a git command against GitHub non-interactively using GITHUB_TOKEN from
# .env, bypassing whatever credential.helper is already configured on this
# machine (e.g. Windows' Git Credential Manager, which pops a GUI prompt and
# just hangs forever in a non-interactive shell). Doesn't touch any git
# config, global or local — the token is supplied per-invocation via `-c`.
#
# Usage:
#   ./scripts/git-auth.sh push origin main
#   ./scripts/git-auth.sh pull
#   ./scripts/git-auth.sh fetch --all
#
# Requires GITHUB_TOKEN in .env (same token the orchestrator itself uses for
# its own git operations — see apps/orchestrator/src/git/repo.ts).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  echo ".env not found at repo root." >&2
  exit 1
fi

GITHUB_TOKEN=$(node -e "
  const dotenv = require('dotenv');
  const { parsed } = dotenv.config({ path: '.env', quiet: true });
  process.stdout.write((parsed && parsed.GITHUB_TOKEN) || '');
")

if [ -z "$GITHUB_TOKEN" ]; then
  echo "GITHUB_TOKEN not set in .env — can't authenticate." >&2
  exit 1
fi

git \
  -c credential.helper= \
  -c "credential.https://github.com.helper=!f() { echo username=x-access-token; echo \"password=$GITHUB_TOKEN\"; }; f" \
  "$@"
