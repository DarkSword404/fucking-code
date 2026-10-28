#!/usr/bin/env bash
# Install the Chromium used by builtin workbench tasks.
#
# Builtin workbench uses playwright-core directly; it does NOT need the OpenCode
# Playwright MCP. Run this once on the machine that hosts Fucking Code.
#
#   ./scripts/install-agent-browser.sh
#
# If the browser cannot start because shared libraries are missing:
#   sudo npx -y playwright@1.64.1 install-deps chromium

set -euo pipefail
cd "$(dirname "$0")/.."

PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.64.1}"

say() { printf '\033[1;36m[fucking-code]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fucking-code]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fucking-code]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npx >/dev/null 2>&1 || fail "npx is required."

if [ -z "${PLAYWRIGHT_DOWNLOAD_HOST:-}" ] && command -v curl >/dev/null 2>&1; then
  if ! curl -sI --max-time 6 https://cdn.playwright.dev/ >/dev/null 2>&1; then
    export PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.npmmirror.com/binaries/playwright"
    say "Playwright CDN is unreachable; using the npmmirror browser mirror."
  fi
fi

say "Installing Chromium for Playwright ${PLAYWRIGHT_VERSION}…"
npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium

if node -e "require.resolve('playwright-core')" >/dev/null 2>&1; then
  BROWSER_PATH="$(node -e "const {chromium}=require('playwright-core'); console.log(chromium.executablePath())" 2>/dev/null || true)"
  if [ -n "$BROWSER_PATH" ] && [ -x "$BROWSER_PATH" ]; then
    say "Chromium: $BROWSER_PATH"
    say "Builtin workbench auto-detects this path; no env var required."
  fi
fi

if command -v google-chrome >/dev/null 2>&1; then
  say "System Google Chrome: $(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  say "System Chromium: $(command -v chromium)"
fi

warn "If Chromium cannot start, install shared libraries once with:"
warn "  sudo npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium"
