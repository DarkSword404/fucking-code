#!/usr/bin/env bash
# Fucking Code one-click local launcher.
#
#   ./start.sh                 build once, then serve the app on http://127.0.0.1:8787
#   ./start.sh --dev           hot-reload mode (API + Vite) on http://127.0.0.1:5174
#   ./start.sh --with-browser  install Playwright MCP + Chromium, then start
#   ./start.sh --install-browser  install browser tools only and exit
#   ./start.sh --help          show this help
#
# Everything it creates at runtime (database, repositories, worktrees, logs,
# build output) stays in gitignored paths. No credentials are written to disk
# unless you put them in .env yourself.

set -euo pipefail
cd "$(dirname "$0")"

MODE="start"
WITH_BROWSER=0
INSTALL_BROWSER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --with-browser) WITH_BROWSER=1 ;;
    --install-browser) INSTALL_BROWSER_ONLY=1 ;;
    --help|-h)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1;36m[fucking-code]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fucking-code]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node.js 22.13+ first."
command -v npm >/dev/null 2>&1 || fail "npm is required."

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  fail "Node.js $(node -v) is too old; Fucking Code needs Node.js 22.13+."
fi
say "Node.js $(node -v) · npm $(npm -v)"

# .env is optional, but copying the documented defaults makes the first run
# predictable. Never overwrite an existing file (it may contain real secrets).
if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from .env.example. Edit it if you need a model/API key."
fi

if [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/vite ]; then
  say "Installing dependencies (first run only)…"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
fi

read_env_port() {
  grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}
PORT_VALUE="${PORT:-$(read_env_port)}"
PORT_VALUE="${PORT_VALUE:-8787}"

if [ "$INSTALL_BROWSER_ONLY" = "1" ]; then
  exec bash scripts/install-agent-browser.sh
fi

if [ "$WITH_BROWSER" = "1" ]; then
  say "Installing optional browser tools for QA/Security/DevOps…"
  bash scripts/install-agent-browser.sh
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

say "Starting Fucking Code…"
say "Open http://127.0.0.1:${PORT_VALUE} (press Ctrl+C to stop)"
exec npm start
