#!/usr/bin/env bash
# sf-gw.sh — quick switch the claude CLI gateway/model for factory-server.
#
#   sf-gw.sh list              list available gateway profiles
#   sf-gw.sh use <profile>     apply a profile and recreate factory (3-5s blip)
#   sf-gw.sh current           show what the running factory is using
#
# Profiles live in deploy/gateways/<name>.env and contain only the gateway-
# specific vars (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
# and optionally FACTORY_FAKE_CLAUDE). This script merges those keys into the
# main .env (replacing any prior values) then force-recreates the factory
# container — podman-compose does NOT pick up env_file-only changes otherwise.
#
# Run from the host:  bash /opt/sf/deploy/sf-gw.sh use cc580

set -euo pipefail

# Resolve the deploy dir regardless of cwd (script may be invoked by path).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
GW_DIR="${SCRIPT_DIR}/gateways"

# Keys a profile is allowed to set; everything else in .env is preserved.
GW_KEYS=(ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL FACTORY_FAKE_CLAUDE)

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

cmd_list() {
  printf '%-14s %-36s %s\n' "PROFILE" "BASE_URL" "MODEL"
  printf '%-14s %-36s %s\n' "-------" "--------" "-----"
  local f name base model
  for f in "$GW_DIR"/*.env; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .env)"
    base="$(grep -E "^ANTHROPIC_BASE_URL=" "$f" | head -1 | cut -d= -f2-)"
    model="$(grep -E "^ANTHROPIC_MODEL=" "$f" | head -1 | cut -d= -f2-)"
    [ -n "$(grep -E "^FACTORY_FAKE_CLAUDE=1" "$f")" ] && model="(fake — no gateway)"
    printf '%-14s %-36s %s\n' "$name" "${base:-(cleared)}" "${model:-(none)}"
  done
}

# Merge profile keys into .env: drop any existing lines setting these keys,
# then append the profile's lines verbatim. Other .env entries are untouched.
apply_profile() {
  local pf="$1"
  local src="$GW_DIR/$pf.env"
  [ -f "$src" ] || { echo "error: no such profile '$pf' (try: sf-gw.sh list)" >&2; exit 1; }
  [ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found" >&2; exit 1; }

  # Build a sed script deleting any line beginning with one of the GW_KEYS=.
  local del_re
  del_re="^($(IFS='|'; echo "${GW_KEYS[*]}"))="
  # grep -v keeps everything NOT a gateway key; then append profile lines.
  { grep -vE "$del_re" "$ENV_FILE" || true; echo; echo "# --- applied gateway profile: $pf ($(date +'%F %T')) ---"; cat "$src"; } \
    > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
}

cmd_use() {
  local pf="${1:-}"
  [ -n "$pf" ] || usage
  echo "applying gateway profile '$pf' ..."
  apply_profile "$pf"
  echo "recreating factory (force) ..."
  (cd "$SCRIPT_DIR" && podman compose up -d --force-recreate factory >/dev/null 2>&1)
  sleep 3
  echo "current:"
  cmd_current
}

cmd_current() {
  local base model fake
  base="$(podman exec sf_factory_1 sh -c 'echo "$ANTHROPIC_BASE_URL"' 2>/dev/null || true)"
  model="$(podman exec sf_factory_1 sh -c 'echo "$ANTHROPIC_MODEL"' 2>/dev/null || true)"
  fake="$(podman exec sf_factory_1 sh -c 'echo "$FACTORY_FAKE_CLAUDE"' 2>/dev/null || true)"
  if [ "$fake" = "1" ]; then
    echo "  mode:   FAKE (FACTORY_FAKE_CLAUDE=1, no gateway)"
  else
    echo "  mode:   REAL"
    echo "  gateway: ${base:-(unset)}"
    echo "  model:   ${model:-(unset)}"
  fi
}

[ $# -ge 1 ] || usage
case "$1" in
  list)    cmd_list ;;
  use)     cmd_use "${2:-}" ;;
  current) cmd_current ;;
  *)       usage ;;
esac
