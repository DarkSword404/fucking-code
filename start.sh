#!/usr/bin/env bash
# Fucking Code one-click local/server launcher.
#
#   ./start.sh                       build once, then serve on http://127.0.0.1:8787
#   ./start.sh --dev                 hot-reload mode (API + Vite) on http://127.0.0.1:5174
#   ./start.sh --server              bind 0.0.0.0 and prepare session-mode defaults
#   ./start.sh --server --url=https://dev.example.com
#   ./start.sh --with-browser        install Chromium for workbench, then start
#   ./start.sh --install-browser     install Chromium only and exit
#   ./start.sh --doctor              run deployment preflight only
#   ./start.sh --help                show this help
#
# Everything it creates at runtime (database, repositories, worktrees, logs,
# build output) stays in gitignored paths. No credentials are written to disk
# unless you put them in .env yourself.

set -euo pipefail
cd "$(dirname "$0")"

MODE="start"
WITH_BROWSER=0
INSTALL_BROWSER_ONLY=0
SERVER_MODE=0
DOCTOR_ONLY=0
PUBLIC_URL=""

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --with-browser) WITH_BROWSER=1 ;;
    --install-browser) INSTALL_BROWSER_ONLY=1 ;;
    --server) SERVER_MODE=1 ;;
    --doctor) DOCTOR_ONLY=1 ;;
    --url=*) PUBLIC_URL="${arg#--url=}" ;;
    --url)
      echo "Use --url=https://your-host.example (the value must follow =)" >&2
      exit 2
      ;;
    --help|-h)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1;36m[fucking-code]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fucking-code]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fucking-code]\033[0m %s\n' "$*" >&2; exit 1; }

env_get() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

env_set() {
  local key="$1" value="$2"
  local escaped="${value//&/\\&}"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

command -v node >/dev/null 2>&1 || fail "Node.js is required. Run scripts/install-server.sh or install Node.js 22.13+ first."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v git >/dev/null 2>&1 || fail "git is required. Install git (or use the provided Docker image)."

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  fail "Node.js $(node -v) is too old; Fucking Code needs Node.js 22.13+."
fi
say "Node.js $(node -v) · npm $(npm -v)"

# .env is optional, but copying the documented defaults makes the first run
# predictable. Never overwrite an existing file (it may contain real secrets).
FRESH_ENV=0
if [ ! -f .env ]; then
  cp .env.example .env
  FRESH_ENV=1
  say "Created .env from .env.example."
fi

if [ "$SERVER_MODE" = "1" ]; then
  env_set HOST "0.0.0.0"
  if [ -z "$(env_get WEB_ORIGIN)" ] || [ "$FRESH_ENV" = "1" ]; then
    env_set WEB_ORIGIN "${PUBLIC_URL:-http://127.0.0.1:8787}"
  fi
  if [ -n "$PUBLIC_URL" ]; then
    env_set WEB_ORIGIN "$PUBLIC_URL"
    env_set PUBLIC_BASE_URL "$PUBLIC_URL"
    case "$PUBLIC_URL" in
      https://*) env_set COOKIE_SECURE "true" ;;
      *) env_set COOKIE_SECURE "false" ;;
    esac
  fi
  if [ "$FRESH_ENV" = "1" ]; then
    env_set AUTH_MODE "session"
    warn "Server mode: AUTH_MODE=session. Create the admin password with:"
    warn "  npx tsx scripts/init-admin.ts"
  elif [ "$(env_get AUTH_MODE)" = "dev" ]; then
    warn "Server mode with AUTH_MODE=dev: there is no login. Use session for a public host."
  fi
  if [ -z "$PUBLIC_URL" ]; then
    warn "No --url supplied; PUBLIC_BASE_URL/WEB_ORIGIN stay local. Set them before exposing the host."
  fi
fi

if [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/vite ]; then
  say "Installing dependencies (first run only)…"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi

if [ "$INSTALL_BROWSER_ONLY" = "1" ]; then
  exec bash scripts/install-agent-browser.sh
fi

if [ "$WITH_BROWSER" = "1" ]; then
  say "Installing Chromium for builtin workbench tasks…"
  bash scripts/install-agent-browser.sh
fi

# Keep the local OpenCode gateway URL in sync with the actual background
# service. The service may pick a different port on a new machine.
GATEWAY="$(env_get MODEL_GATEWAY)"
GATEWAY="${GATEWAY:-opencode}"
if [ "$GATEWAY" = "opencode" ]; then
  if ! command -v opencode >/dev/null 2>&1; then
    fail "OpenCode CLI is required for MODEL_GATEWAY=opencode. Install it with: curl -fsSL https://opencode.ai/install | bash"
  fi
  if ! opencode service status >/dev/null 2>&1; then
    say "Starting OpenCode background service…"
    opencode service start >/dev/null 2>&1 || true
  fi
  OPENCODE_STATUS="$(opencode service status 2>/dev/null || true)"
  OPENCODE_URL_VALUE="$(printf '%s\n' "$OPENCODE_STATUS" | grep -Eo 'https?://[^[:space:]]+' | tail -1 || true)"
  if [ -n "$OPENCODE_URL_VALUE" ]; then
    env_set OPENCODE_URL "$OPENCODE_URL_VALUE"
    say "OpenCode gateway: $OPENCODE_URL_VALUE"
  else
    warn "Could not detect the OpenCode service URL; check: opencode service status"
  fi
  if ! opencode auth list 2>/dev/null | grep -qiE 'stored|已存储|已登录'; then
    warn "OpenCode is not logged in yet. Start the app, open 管理后台 → OpenCode, and use the web device-code flow."
    warn "Alternatively import credentials: scripts/opencode-auth.sh import <file>"
  fi
fi

if [ "$GATEWAY" = "openai" ] || [ "$GATEWAY" = "openai-compatible" ]; then
  if [ -z "$(env_get MODEL_API_KEY)" ] && [ -z "${MODEL_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    fail "MODEL_GATEWAY=${GATEWAY} needs MODEL_API_KEY or OPENAI_API_KEY in .env."
  fi
fi

if [ "$DOCTOR_ONLY" = "1" ]; then
  exec npx tsx scripts/preflight.ts
fi

say "Running preflight…"
if ! npx tsx scripts/preflight.ts; then
  fail "Preflight failed; fix the items above or run ./start.sh --doctor for details."
fi

if [ "$MODE" = "dev" ]; then
  say "Dev mode: API + Vite (hot reload)."
  say "Open http://127.0.0.1:5174 (press Ctrl+C to stop)"
  exec npm run dev
fi

# The API serves apps/web/dist in production mode. Rebuild when missing or when
# frontend sources changed since the last build.
if [ ! -f apps/web/dist/index.html ] || find apps/web/src -type f -newer apps/web/dist/index.html -print -quit | grep -q .; then
  say "Building frontend…"
  npm run build
fi

PORT_VALUE="${PORT:-$(env_get PORT)}"
PORT_VALUE="${PORT_VALUE:-8787}"
HOST_VALUE="${HOST:-$(env_get HOST)}"
HOST_VALUE="${HOST_VALUE:-127.0.0.1}"

say "Starting Fucking Code…"
say "Listening on http://${HOST_VALUE}:${PORT_VALUE} (press Ctrl+C to stop)"
exec env NODE_ENV=production ./node_modules/.bin/tsx apps/api/src/index.ts
