#!/usr/bin/env bash
# Move OpenCode subscription credentials between hosts.
#
#   ./scripts/opencode-auth.sh export [file]
#   ./scripts/opencode-auth.sh import <file>
#
# `auth export` contains plaintext credentials. Transfer the file over a secure
# channel (scp/ssh), chmod 600, and delete it afterwards. Never commit it.

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1;36m[fucking-code]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fucking-code]\033[0m %s\n' "$*" >&2; exit 1; }

command -v opencode >/dev/null 2>&1 || fail "opencode CLI is required."

action="${1:-}"
case "$action" in
  export)
    target="${2:-opencode-auth.json}"
    if [ -e "$target" ]; then
      fail "$target already exists; move it first"
    fi
    umask 077
    opencode auth export >"$target"
    chmod 600 "$target"
    say "Exported to $target (contains secrets, mode 600)."
    say "Transfer with: scp $target user@new-host:/tmp/"
    ;;
  import)
    [ -n "${2:-}" ] || fail "usage: $0 import <file>"
    [ -f "$2" ] || fail "file not found: $2"
    opencode auth import "$2"
    say "Imported credentials from $2. Delete the file when done."
    ;;
  *)
    fail "usage: $0 export [file] | $0 import <file>"
    ;;
esac
