#!/usr/bin/env bash
# Install the optional browser toolchain used by QA/Security/DevOps workbenches.
#
# It does two things:
#   1. downloads a headless Chromium for Playwright;
#   2. registers the Playwright MCP server with OpenCode.
#
# Run it once on the machine that hosts Fucking Code. It is safe to re-run.
# If OpenCode is already running, restart its service afterwards so it picks up
# the new MCP server.
#
# If Playwright's CDN is slow or blocked, set a mirror before running:
#   PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
#     ./scripts/install-agent-browser.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.64.1}"

say() { printf '\033[1;36m[fucking-code]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fucking-code]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fucking-code]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npx >/dev/null 2>&1 || fail "npx is required."
command -v opencode >/dev/null 2>&1 || fail "The OpenCode CLI is required (opencode)."

say "Installing Chromium for Playwright ${PLAYWRIGHT_VERSION}…"
# Browser-only first: this does not need root. If the host is missing shared
# libraries, run the printed install-deps command once with sudo.
npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium
warn "If Chromium cannot start, install system libraries once with:"
warn "  sudo npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium"

if opencode mcp list 2>/dev/null | grep -qi playwright; then
  say "Playwright MCP is already registered."
else
  say "Registering Playwright MCP with OpenCode (global config)…"
  opencode mcp add --global playwright -- npx -y @playwright/mcp@latest
fi

say "Current MCP servers:"
opencode mcp list || true

warn "If OpenCode was already running, restart it so workbench sessions see the browser tools."
