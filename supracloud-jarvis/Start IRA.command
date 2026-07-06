#!/usr/bin/env bash
# =============================================================================
# Start IRA.command — double-click launcher for macOS (Finder runs .command
# files in Terminal). Thin wrapper around start-ira.sh, which checks .env,
# Postgres, Redis, Ollama, then starts the IRA backend + frontend and opens
# the dashboard. No secrets live in this file — configuration comes from .env.
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")"
bash ./start-ira.sh
status=$?

echo ""
if [ "$status" -ne 0 ]; then
    echo "IRA did not start cleanly — see the messages above."
else
    echo "IRA is ready, boss."
fi

# Keep the Terminal window open so the summary is readable after double-click.
read -r -p "Press Enter to close this window..." _ || true
exit "$status"
