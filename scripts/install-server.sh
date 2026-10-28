#!/usr/bin/env bash
# One-click installer for a Debian/Ubuntu host.
#
#   ./scripts/install-server.sh --url=https://dev.example.com
#   ./scripts/install-server.sh --url=https://dev.example.com --systemd
#   ./scripts/install-server.sh --no-browser            # skip Chromium
#   ./scripts/install-server.sh --opencode-auth=file.json
#   ./scripts/install-server.sh --docker              # isolated test/deploy/ops containers
#
# It installs Node.js 22, git, bubblewrap, OpenCode, npm dependencies, Chromium
# (unless disabled), creates .env, initializes the admin account, and can
# install systemd units. It never overwrites an existing .env.

set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

PUBLIC_URL=""
WITH_BROWSER=1
WITH_SYSTEMD=0
WITH_DOCKER=0
OPENCODE_AUTH_FILE=""
ADMIN_PASSWORD=""

for arg in "$@"; do
  case "$arg" in
    --url=*) PUBLIC_URL="${arg#--url=}" ;;
    --no-browser) WITH_BROWSER=0 ;;
    --docker) WITH_DOCKER=1 ;;
    --systemd) WITH_SYSTEMD=1 ;;
    --opencode-auth=*) OPENCODE_AUTH_FILE="${arg#--opencode-auth=}" ;;
    --admin-password=*) ADMIN_PASSWORD="${arg#--admin-password=}" ;;
    --help|-h)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m[fucking-code]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[fucking-code]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fucking-code]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || fail "This installer targets Linux (Debian/Ubuntu)."
command -v apt-get >/dev/null 2>&1 || fail "apt-get is required."

SUDO=()
if [ "$EUID" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "Run as root or install sudo."
  SUDO=(sudo)
fi
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || fail "Cannot resolve home directory for $RUN_USER"

run_as_user() {
  if [ "$EUID" -eq 0 ]; then
    runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" PATH="$RUN_HOME/.opencode/bin:$RUN_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"
  else
    env HOME="$RUN_HOME" PATH="$RUN_HOME/.opencode/bin:$RUN_HOME/.local/bin:$PATH" "$@"
  fi
}

say "Installing system packages…"
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git build-essential bubblewrap openssl unzip

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    NODE_OK=1
  fi
fi
if [ "$NODE_OK" -ne 1 ]; then
  say "Installing Node.js 22 from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO[@]}" -E bash -
  "${SUDO[@]}" apt-get install -y nodejs
fi
command -v node >/dev/null 2>&1 || fail "Node.js installation failed."
say "Node.js $(node -v) · npm $(npm -v)"

if [ "$WITH_DOCKER" = "1" ]; then
  say "Installing Docker for project test/deploy/ops isolation…"
  "${SUDO[@]}" apt-get install -y --no-install-recommends docker.io
  "${SUDO[@]}" systemctl enable --now docker.service
  "${SUDO[@]}" usermod -aG docker "$RUN_USER"
  "${SUDO[@]}" docker pull "${RUNNER_IMAGE:-node:22-bookworm-slim}"
fi

if ! run_as_user bash -lc 'command -v opencode >/dev/null 2>&1'; then
  say "Installing OpenCode CLI…"
  run_as_user bash -lc 'curl -fsSL https://opencode.ai/install | bash'
fi
OPENCODE_BIN="$(run_as_user bash -lc 'command -v opencode || true')"
[ -n "$OPENCODE_BIN" ] || fail "OpenCode CLI installation failed; install it manually from https://opencode.ai/install"

say "Installing npm dependencies…"
run_as_user npm ci --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from .env.example."
fi
"${SUDO[@]}" chown "$RUN_USER":"$RUN_USER" .env 2>/dev/null || true

env_set() {
  local key="$1" value="$2"
  local escaped="${value//&/\\&}"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
env_get() {
  grep -E "^${1}=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

env_set HOST "0.0.0.0"
env_set PORT "8787"
env_set AUTH_MODE "session"
env_set APP_INSTANCE_ID "fucking-code"
if [ "$WITH_DOCKER" = "1" ]; then
  env_set RUNNER_MODE "docker"
  env_set PREVIEW_MODE "docker"
  env_set RUNNER_IMAGE "${RUNNER_IMAGE:-node:22-bookworm-slim}"
else
  env_set RUNNER_MODE "host"
  env_set PREVIEW_MODE "host"
fi
if [ -n "$PUBLIC_URL" ]; then
  env_set WEB_ORIGIN "$PUBLIC_URL"
  env_set PUBLIC_BASE_URL "$PUBLIC_URL"
  case "$PUBLIC_URL" in
    https://*) env_set COOKIE_SECURE "true" ;;
    *) env_set COOKIE_SECURE "false" ;;
  esac
else
  warn "No --url supplied; WEB_ORIGIN stays local. Set PUBLIC_BASE_URL/WEB_ORIGIN before exposing the server."
fi
if [ -z "$(env_get SIGNUP_INVITE_CODE)" ]; then
  INVITE="$(openssl rand -hex 8)"
  env_set SIGNUP_INVITE_CODE "$INVITE"
  say "Generated SIGNUP_INVITE_CODE: $INVITE"
fi
"${SUDO[@]}" chown "$RUN_USER":"$RUN_USER" .env 2>/dev/null || true

# OpenCode credentials: import a previously exported JSON, log in interactively,
# or stop here with instructions.
if [ -n "$OPENCODE_AUTH_FILE" ]; then
  [ -f "$OPENCODE_AUTH_FILE" ] || fail "OpenCode auth file not found: $OPENCODE_AUTH_FILE"
  say "Importing OpenCode credentials…"
  run_as_user env HOME="$RUN_HOME" "$OPENCODE_BIN" auth import "$OPENCODE_AUTH_FILE"
elif ! run_as_user env HOME="$RUN_HOME" "$OPENCODE_BIN" auth list 2>/dev/null | grep -qiE 'stored|已存储|已登录'; then
  warn "OpenCode is not logged in yet. The installer will continue without blocking."
  warn "After the app starts, log in at: 管理后台 → OpenCode → 开始网页验证"
  warn "Or import credentials with: --opencode-auth=/path/to/auth.json"
fi

say "Starting OpenCode service…"
run_as_user env HOME="$RUN_HOME" "$OPENCODE_BIN" service start >/dev/null 2>&1 || true
OPENCODE_URL_VALUE="$(run_as_user env HOME="$RUN_HOME" "$OPENCODE_BIN" service status 2>/dev/null | grep -Eo 'https?://[^[:space:]]+' | tail -1 || true)"
if [ -n "$OPENCODE_URL_VALUE" ]; then
  env_set OPENCODE_URL "$OPENCODE_URL_VALUE"
  say "OpenCode gateway: $OPENCODE_URL_VALUE"
else
  warn "Could not detect OpenCode service URL; check: opencode service status"
fi

say "Building frontend…"
run_as_user npm run build

say "Initializing admin account…"
if [ -n "$ADMIN_PASSWORD" ]; then
  run_as_user env ADMIN_PASSWORD="$ADMIN_PASSWORD" npx tsx scripts/init-admin.ts
else
  run_as_user npx tsx scripts/init-admin.ts
fi

if [ "$WITH_BROWSER" = "1" ]; then
  say "Installing Chromium for workbench tasks…"
  if ! run_as_user bash scripts/install-agent-browser.sh; then
    warn "Chromium install failed; UI workbench checks will be marked uncovered."
  fi
fi

say "Running preflight…"
if ! run_as_user npx tsx scripts/preflight.ts; then
  warn "Preflight reported failures; fix them before starting the service."
fi

if [ "$WITH_SYSTEMD" = "1" ]; then
  say "Installing systemd units…"
  OPENCODE_SERVICE_PATH="$OPENCODE_BIN"
  cat >/tmp/fucking-code.service <<EOF
[Unit]
Description=Fucking Code (API + Web)
After=network-online.target opencode-start.service
Wants=network-online.target opencode-start.service

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$RUN_HOME
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v npm) start
Restart=always
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF
  cat >/tmp/opencode-start.service <<EOF
[Unit]
Description=OpenCode background gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
Group=$RUN_USER
Environment=HOME=$RUN_HOME
ExecStart=-$OPENCODE_SERVICE_PATH service start
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  "${SUDO[@]}" mv /tmp/fucking-code.service /etc/systemd/system/fucking-code.service
  "${SUDO[@]}" mv /tmp/opencode-start.service /etc/systemd/system/opencode-start.service
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable --now opencode-start.service
  "${SUDO[@]}" systemctl enable --now fucking-code.service
fi

say "Install complete."
say "App directory: $APP_DIR"
say "Start manually: ./start.sh --server${PUBLIC_URL:+ --url=$PUBLIC_URL}"
if [ "$WITH_SYSTEMD" = "1" ]; then
  say "Check: systemctl status fucking-code.service"
else
  warn "No systemd units installed; use ./start.sh --server or re-run with --systemd."
fi
say "OpenCode login (if not already configured): ${PUBLIC_URL:-http://127.0.0.1:8787}/admin → OpenCode → 开始网页验证"
warn "OpenCode auth is stored under $RUN_HOME/.local/share/opencode; back it up securely if you migrate hosts."
