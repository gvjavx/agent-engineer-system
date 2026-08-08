#!/usr/bin/env bash
set -euo pipefail

# The agent commits as this identity inside every workspace it touches.
git config --global user.name "${GIT_AUTHOR_NAME:-Autonomous Dev Agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@example.com}"
# Workspaces are bind-mounted volumes; git otherwise refuses repos not owned
# by the current uid ("detected dubious ownership").
git config --global --add safe.directory '*'
git config --global init.defaultBranch main

exec "$@"
