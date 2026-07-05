#!/usr/bin/env bash
# =============================================================================
# start-ira.sh — one-command IRA native stack for Linux / macOS / WSL2.
# Bash counterpart of start-ira.ps1 (Windows). Replaces the retired
# docker-compose path (scripts/dev-start.sh) — everything runs native.
#
# Order: checks (python/node/.env) -> Postgres -> Redis -> Ollama (pull + warm)
#        -> web-research backends (optional) -> IRA backend (uvicorn)
#        -> IRA frontend (Next).
# Each service is started only if it isn't already up, then probed until
# healthy. Optional services (SearXNG / Crawl4AI) are WARN, not fatal.
#
# Usage:
#   ./start-ira.sh                 # bring everything up
#   ./start-ira.sh --skip-frontend # backend only
#   ./stop-ira.sh                  # stop the processes this script started
# =============================================================================

set -uo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
    echo "ERROR: run with bash: bash start-ira.sh" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IRA_DIR="$ROOT/ira"
FRONTEND_DIR="$ROOT/frontend"
RUN_DIR="$ROOT/.ira-run"
mkdir -p "$RUN_DIR"

SKIP_FRONTEND=false
[[ "${1:-}" == "--skip-frontend" ]] && SKIP_FRONTEND=true

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
FAILED=""

ok()   { printf "  ${GREEN}[OK]${NC}   %-12s %s\n" "$1" "${2:-}"; }
warn() { printf "  ${YELLOW}[WARN]${NC} %-12s %s\n" "$1" "${2:-}"; }
fail() { printf "  ${RED}[FAIL]${NC} %-12s %s\n" "$1" "${2:-}"; FAILED="${FAILED} $1"; }

# ── helpers ───────────────────────────────────────────────────────────────────
tcp_up() {  # host port
    (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1
}

http_up() { curl -sf --max-time 5 "$1" > /dev/null 2>&1; }

wait_until() {  # "command string" timeout_sec
    local deadline=$(( $(date +%s) + $2 ))
    while (( $(date +%s) < deadline )); do
        eval "$1" && return 0
        sleep 1
    done
    return 1
}

env_or() {  # VAR default
    local v="${!1:-}"
    [[ -n "$v" ]] && echo "$v" || echo "$2"
}

# ── .env ──────────────────────────────────────────────────────────────────────
echo -e "${CYAN}Starting IRA native stack...${NC}"

if [[ -f "$ROOT/.env" ]]; then
    # Parse KEY=VALUE lines instead of sourcing: values with spaces or shell
    # metacharacters (e.g. OWNER_NAME=Praveen Kumar) must not be executed.
    # Mirrors the .env loader in start-ira.ps1.
    while IFS= read -r _line; do
        if [[ "$_line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            _val="${BASH_REMATCH[2]}"
            _val="${_val%\"}"; _val="${_val#\"}"   # strip surrounding double quotes
            export "${BASH_REMATCH[1]}=${_val}"
        fi
    done < "$ROOT/.env"
    ok ".env" "loaded"
else
    fail ".env" "missing — copy .env.example to .env and fill in the secrets:"
    echo "         cp .env.example .env   (then edit IRA_SECRET_KEY, IRA_ADMIN_PASSWORD, POSTGRES_PASSWORD, REDIS_PASSWORD)"
    exit 1
fi

# ── prerequisite binaries ─────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 && ok "python" "$(python3 --version 2>&1)" \
    || fail "python" "python3 not found — install Python 3.11+"
command -v node >/dev/null 2>&1 && ok "node" "$(node --version 2>&1)" \
    || { $SKIP_FRONTEND || fail "node" "node not found — install Node 20+ (or use --skip-frontend)"; }
command -v curl >/dev/null 2>&1 || fail "curl" "curl not found — install curl"

[[ -n "$FAILED" ]] && { echo -e "${RED}Prerequisites missing:${FAILED}${NC}"; exit 1; }

# ── 1. Postgres ───────────────────────────────────────────────────────────────
PG_HOST=$(env_or POSTGRES_HOST localhost)
PG_PORT=$(env_or POSTGRES_PORT 5432)
if ! tcp_up "$PG_HOST" "$PG_PORT"; then
    # try to start a local service (best effort, no sudo prompt)
    command -v pg_ctlcluster >/dev/null 2>&1 && sudo -n service postgresql start >/dev/null 2>&1 || true
    command -v brew >/dev/null 2>&1 && brew services start postgresql >/dev/null 2>&1 || true
fi
if wait_until "tcp_up $PG_HOST $PG_PORT" 15; then ok "postgres" "port $PG_PORT"
else fail "postgres" "not reachable on $PG_HOST:$PG_PORT — start it (e.g. sudo service postgresql start)"; fi

# ── 2. Redis ──────────────────────────────────────────────────────────────────
REDIS_HOST_V=$(env_or REDIS_HOST localhost)
REDIS_PORT_V=$(env_or REDIS_PORT 6379)
if ! tcp_up "$REDIS_HOST_V" "$REDIS_PORT_V"; then
    command -v redis-server >/dev/null 2>&1 && { redis-server --daemonize yes >/dev/null 2>&1 || true; }
fi
if wait_until "tcp_up $REDIS_HOST_V $REDIS_PORT_V" 15; then ok "redis" "port $REDIS_PORT_V"
else fail "redis" "not reachable on $REDIS_HOST_V:$REDIS_PORT_V — start it (e.g. redis-server --daemonize yes)"; fi

# ── 3. Ollama (serve, pull + warm the fast/deep tiers) ────────────────────────
OLLAMA_BASE="${OLLAMA_BASE_URL:-http://localhost:11434/v1}"; OLLAMA_BASE="${OLLAMA_BASE%/v1}"
KEEP_ALIVE=$(env_or OLLAMA_KEEP_ALIVE 30m)
FAST_MODEL=$(env_or OLLAMA_MODEL_FAST qwen3:8b)
DEEP_MODEL=$(env_or OLLAMA_MODEL_DEEP qwen3:14b)
if ! http_up "$OLLAMA_BASE/api/tags"; then
    if command -v ollama >/dev/null 2>&1; then
        OLLAMA_KEEP_ALIVE="$KEEP_ALIVE" nohup ollama serve > "$RUN_DIR/ollama.log" 2>&1 &
        echo $! > "$RUN_DIR/ollama.pid"
    fi
fi
if wait_until "http_up $OLLAMA_BASE/api/tags" 30; then
    for m in "$FAST_MODEL" "$DEEP_MODEL"; do
        if ! curl -sf "$OLLAMA_BASE/api/tags" | grep -q "\"$m\""; then
            echo "         ollama pull $m ... (first time only, this can take a while)"
            ollama pull "$m" 2>/dev/null || warn "ollama" "could not pull $m — pull it manually"
        fi
        # warm the model so the first chat isn't cold (best effort)
        curl -sf --max-time 120 -X POST "$OLLAMA_BASE/api/generate" \
            -H "Content-Type: application/json" \
            -d "{\"model\":\"$m\",\"prompt\":\"ok\",\"stream\":false,\"keep_alive\":\"$KEEP_ALIVE\"}" >/dev/null 2>&1 || true
    done
    ok "ollama" "$OLLAMA_BASE ($FAST_MODEL + $DEEP_MODEL, keep_alive=$KEEP_ALIVE)"
else
    fail "ollama" "no response at $OLLAMA_BASE — install from https://ollama.com and run: ollama serve"
fi

# ── 4. Web-research backends (optional — research fails soft) ─────────────────
SEARXNG="${SEARXNG_URL:-http://localhost:8888}"; SEARXNG="${SEARXNG%/}"
http_up "$SEARXNG/" && ok "searxng" "$SEARXNG" \
    || warn "searxng" "down ($SEARXNG) — web search disabled, research fails soft"
CRAWL4AI="${CRAWL4AI_URL:-http://localhost:11235}"; CRAWL4AI="${CRAWL4AI%/}"
http_up "$CRAWL4AI/health" && ok "crawl4ai" "$CRAWL4AI" \
    || warn "crawl4ai" "down ($CRAWL4AI) — web reader disabled, research fails soft"

# ── 5. IRA backend (uvicorn) ──────────────────────────────────────────────────
API_PORT=$(env_or IRA_API_PORT 8000)
if ! http_up "http://127.0.0.1:$API_PORT/health"; then
    ( cd "$IRA_DIR" && nohup python3 -m uvicorn main:app --host 127.0.0.1 --port "$API_PORT" \
        > "$RUN_DIR/ira-api.log" 2>&1 & echo $! > "$RUN_DIR/ira-api.pid" )
fi
if wait_until "http_up http://127.0.0.1:$API_PORT/health" 90; then ok "ira-api" "http://127.0.0.1:$API_PORT"
else fail "ira-api" "no /health on $API_PORT — see $RUN_DIR/ira-api.log"; fi

# ── 6. IRA frontend (Next) ────────────────────────────────────────────────────
if $SKIP_FRONTEND; then
    warn "frontend" "skipped (--skip-frontend)"
else
    FE_PORT=$(env_or FRONTEND_PORT 3000)
    if ! tcp_up localhost "$FE_PORT"; then
        if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
            echo "         npm install ... (first time only)"
            ( cd "$FRONTEND_DIR" && npm install --no-audit --no-fund > "$RUN_DIR/npm-install.log" 2>&1 ) \
                || warn "frontend" "npm install failed — see $RUN_DIR/npm-install.log"
        fi
        if [[ -d "$FRONTEND_DIR/.next" ]]; then
            ( cd "$FRONTEND_DIR" && nohup npm run start > "$RUN_DIR/frontend.log" 2>&1 & echo $! > "$RUN_DIR/frontend.pid" )
        else
            warn "frontend" "no production build (.next) — starting dev server; run 'npm run build' for production"
            ( cd "$FRONTEND_DIR" && nohup npm run dev > "$RUN_DIR/frontend.log" 2>&1 & echo $! > "$RUN_DIR/frontend.pid" )
        fi
    fi
    if wait_until "tcp_up localhost $FE_PORT" 90; then ok "frontend" "http://localhost:$FE_PORT"
    else fail "frontend" "not reachable on $FE_PORT — see $RUN_DIR/frontend.log"; fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ -n "$FAILED" ]]; then
    echo -e "${RED}STACK NOT FULLY UP — failed:${FAILED}${NC}"
    exit 1
else
    echo -e "${GREEN}ALL UP. IRA is online. Good morning.${NC}"
    echo -e "  UI:  ${CYAN}http://localhost:$(env_or FRONTEND_PORT 3000)${NC}"
    echo -e "  API: ${CYAN}http://127.0.0.1:$(env_or IRA_API_PORT 8000)/docs${NC}"
    echo -e "  Stop with: ${CYAN}./stop-ira.sh${NC}"
fi
