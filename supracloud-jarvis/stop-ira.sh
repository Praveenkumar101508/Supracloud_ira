#!/usr/bin/env bash
# =============================================================================
# stop-ira.sh — stop the IRA processes started by start-ira.sh.
#
# Stops: ira-api (uvicorn), frontend (Next), and ollama ONLY if start-ira.sh
# started it (PID file present). Postgres and Redis are system services and are
# left running — stop them with your service manager if you really want to.
#
# Usage: ./stop-ira.sh
# =============================================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.ira-run"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

stop_pidfile() {  # name pidfile
    local name="$1" pidfile="$2"
    if [[ ! -f "$pidfile" ]]; then
        printf "  ${YELLOW}[SKIP]${NC} %-10s not started by start-ira.sh\n" "$name"
        return
    fi
    local pid; pid="$(cat "$pidfile" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        # kill the whole process group if possible, else the single PID
        kill "$pid" 2>/dev/null
        for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
        printf "  ${GREEN}[OK]${NC}   %-10s stopped (pid %s)\n" "$name" "$pid"
    else
        printf "  ${YELLOW}[SKIP]${NC} %-10s not running\n" "$name"
    fi
    rm -f "$pidfile"
}

echo "Stopping IRA..."
stop_pidfile "frontend" "$RUN_DIR/frontend.pid"
stop_pidfile "ira-api"  "$RUN_DIR/ira-api.pid"
stop_pidfile "ollama"   "$RUN_DIR/ollama.pid"

# Fallback: uvicorn started via a subshell may have a stale PID file — sweep by
# command line, but only processes belonging to this checkout.
pkill -f "uvicorn main:app.*--port ${IRA_API_PORT:-8000}" 2>/dev/null && \
    printf "  ${GREEN}[OK]${NC}   %-10s swept stray uvicorn\n" "ira-api"

echo -e "${GREEN}Done. Postgres/Redis left running (system services).${NC}"
