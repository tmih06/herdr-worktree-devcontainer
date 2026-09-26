#!/usr/bin/env bash
# Real end-to-end run: a genuine devcontainer, a genuine sshd, a genuine
# herdr server inside it, and a genuine saved SSH machine in herdr.
#
# Slow (pulls an image, builds it, installs herdr) and needs:
#   docker running, the devcontainer CLI on PATH, and a linked plugin.
#
#   DEVCONTAINER_CLI=/tmp/dccli/node_modules/.bin bash tests/real-e2e.sh
set -uo pipefail

PLUGIN_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEVCONTAINER_CLI="${DEVCONTAINER_CLI:-$(command -v devcontainer || true)}"
[ -n "$DEVCONTAINER_CLI" ] || { echo 'devcontainer CLI not found; set DEVCONTAINER_CLI' >&2; exit 2; }

PLUGIN_ID=worktree-devcontainer
BIN="$(dirname "$DEVCONTAINER_CLI")"
command -v herdr >/dev/null || { echo 'herdr not on PATH' >&2; exit 2; }
herdr plugin list 2>/dev/null | grep -q "$PLUGIN_ID" || {
  echo "link the plugin first: herdr plugin link $PLUGIN_ROOT" >&2; exit 2; }

SANDBOX="$(mktemp -d)"

# Only ever remove containers this script created. `label=devcontainer.local_folder`
# matches every devcontainer on the host, including the user's own, so the
# workspace path has to be matched against this sandbox explicitly.
cleanup() {
  local c folder
  for c in $(docker ps -aq --filter "label=devcontainer.local_folder" 2>/dev/null); do
    folder="$(docker inspect -f '{{index .Config.Labels "devcontainer.local_folder"}}' "$c" 2>/dev/null)"
    case "$folder" in
      "$SANDBOX"/*) echo "removing test container $c ($folder)"; docker rm -f "$c" >/dev/null 2>&1 ;;
      *) echo "leaving container $c alone ($folder)" ;;
    esac
  done
  [ -n "${MACHINE_ID:-}" ] && herdr machine remove "$MACHINE_ID" >/dev/null 2>&1
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

export PATH="$BIN:$PATH"
export HERDR_PLUGIN_ROOT="$PLUGIN_ROOT"
export HERDR_PLUGIN_ID="$PLUGIN_ID"
export HERDR_PLUGIN_STATE_DIR="$SANDBOX/state"
export HERDR_PLUGIN_CONFIG_DIR="$SANDBOX/config"

REPO="$SANDBOX/repo"
WT="$SANDBOX/wt"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t.t
git -C "$REPO" config user.name t
mkdir -p "$REPO/.devcontainer"
cat >"$REPO/.devcontainer/devcontainer.json" <<'JSON'
{
  // minimal but real: a small image with the sshd feature added by the plugin
  "name": "wtdc-real",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "remoteUser": "vscode",
  "postCreateCommand": "echo upstream-post-create-ran"
}
JSON
git -C "$REPO" add -A
git -C "$REPO" commit -qm init
git -C "$REPO" worktree add -q -b real "$WT"

echo "==> provisioning $WT (this builds a real image, be patient)"
"$PLUGIN_ROOT/bin/wtdc" provision "$WT" "" real
rc=$?
[ "$rc" -eq 0 ] || { echo "provision failed: $rc"; exit "$rc"; }

CONTAINER_ID="$(jq -r --arg k "$WT" '.entries[$k].container_id' "$HERDR_PLUGIN_STATE_DIR/state.json")"
MACHINE_ID="$(jq -r --arg k "$WT" '.entries[$k].machine_id' "$HERDR_PLUGIN_STATE_DIR/state.json")"

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m %s\n' "$1"
  else printf '  \033[31mFAIL\033[0m %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

echo
echo "==> verifying the real thing"
check 'container is running' 'yes' \
  "$(docker ps -q --filter "id=$CONTAINER_ID" | grep -q . && echo yes || echo no)"
check 'sshd is listening inside' 'yes' \
  "$(docker exec "$CONTAINER_ID" sh -lc 'pgrep sshd >/dev/null && echo yes || echo no')"
CTR_USER="$(docker exec "$CONTAINER_ID" cat /tmp/wtdc-user 2>/dev/null | tr -d '\r\n')"
check 'container user recorded is not root' 'yes' \
  "$([ -n "$CTR_USER" ] && [ "$CTR_USER" != root ] && echo yes || echo no)"
check 'herdr is installed in the remoteUser home' 'yes' \
  "$(docker exec "$CONTAINER_ID" sh -lc "export PATH=\"/home/$CTR_USER/.local/bin:\$PATH\"; command -v herdr >/dev/null && echo yes || echo no")"
check 'herdr server answers inside' 'yes' \
  "$(docker exec "$CONTAINER_ID" sh -lc "export PATH=\"/home/$CTR_USER/.local/bin:\$PATH\"; herdr status server >/dev/null 2>&1 && echo yes || echo no")"
check 'authorized_keys landed in the remoteUser home' 'yes' \
  "$(docker exec "$CONTAINER_ID" sh -lc "[ -s /home/$CTR_USER/.ssh/authorized_keys ] && echo yes || echo no")"
check 'machine profile exists' 'yes' \
  "$(herdr machine list --json | jq -e --arg m "$MACHINE_ID" '[(if type=="object" then (.machines//[]) else . end)[] | select(.id==$m)] | length > 0' >/dev/null && echo yes || echo no)"
check 'remote command through the machine' 'yes' \
  "$(herdr --machine "$MACHINE_ID" agent list >/dev/null 2>&1 && echo yes || echo no)"
check 'remote workspace opened in the container' 'yes' \
  "$(herdr --machine "$MACHINE_ID" workspace list 2>/dev/null | jq -e '(.result.workspaces // []) | length > 0' >/dev/null && echo yes || echo no)"

echo
echo "==> teardown"

"$PLUGIN_ROOT/bin/wtdc" teardown "$WT" >/dev/null 2>&1
check 'container destroyed' 'no' \
  "$(docker ps -aq --filter "id=$CONTAINER_ID" | grep -q . && echo yes || echo no)"
check 'machine profile removed' 'no' \
  "$(herdr machine list --json | jq -e --arg m "$MACHINE_ID" '[(if type=="object" then (.machines//[]) else . end)[] | select(.id==$m)] | length > 0' >/dev/null && echo yes || echo no)"
check 'state emptied' '0' "$(jq -r '.entries | length' "$HERDR_PLUGIN_STATE_DIR/state.json")"

echo
[ "$fail" -eq 0 ] && printf '\033[32mreal e2e passed\033[0m\n' || printf '\033[31m%d real check(s) failed\033[0m\n' "$fail"
exit "$fail"
