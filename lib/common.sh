#!/usr/bin/env bash
# Shared helpers: logging, config loading, small utilities.
# Sourced by bin/wtdc and panes/*.sh. Not executable on its own.

if [ -n "${WTDC_COMMON_SH_LOADED:-}" ]; then
  return 0
fi
WTDC_COMMON_SH_LOADED=1

WTDC_ROOT="${HERDR_PLUGIN_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"

# Colours only when stderr/stdout is a terminal, so hook logs stay readable.
if [ -t 1 ]; then
  WTDC_C_RESET=$'\033[0m'
  WTDC_C_RED=$'\033[31m'
  WTDC_C_GREEN=$'\033[32m'
  WTDC_C_YELLOW=$'\033[33m'
  WTDC_C_BLUE=$'\033[34m'
  WTDC_C_CYAN=$'\033[36m'
  WTDC_C_DIM=$'\033[2m'
else
  WTDC_C_RESET='' WTDC_C_RED='' WTDC_C_GREEN='' WTDC_C_YELLOW=''
  WTDC_C_BLUE='' WTDC_C_CYAN='' WTDC_C_DIM=''
fi

wtdc::die() {
  printf '%serror:%s %s\n' "$WTDC_C_RED" "$WTDC_C_RESET" "$*" >&2
  exit 1
}

wtdc::warn() {
  printf '%swarn:%s %s\n' "$WTDC_C_YELLOW" "$WTDC_C_RESET" "$*" >&2
}

wtdc::step() {
  printf '%s==>%s %s\n' "$WTDC_C_BLUE" "$WTDC_C_RESET" "$*"
}

wtdc::ok() {
  printf '%sok:%s %s\n' "$WTDC_C_GREEN" "$WTDC_C_RESET" "$*"
}

wtdc::info() {
  printf '%s::%s %s\n' "$WTDC_C_CYAN" "$WTDC_C_RESET" "$*"
}

wtdc::detail() {
  printf '   %s%s%s\n' "$WTDC_C_DIM" "$*" "$WTDC_C_RESET"
}

# Always call Herdr through HERDR_BIN_PATH: it is the running binary and works
# across the Unix socket / Windows named pipe difference.
wtdc::herdr() {
  "${HERDR_BIN_PATH:-herdr}" "$@"
}

wtdc::need() {
  command -v "$1" >/dev/null 2>&1 || wtdc::die "required command not found: $1"
}

wtdc::have() {
  command -v "$1" >/dev/null 2>&1
}

# Host tool prerequisites. node is implied by devcontainer (an npm package),
# but check anyway because the JSONC merge needs it.
wtdc::require_host_tools() {
  wtdc::need docker
  wtdc::need devcontainer
  wtdc::need jq
  wtdc::need ssh
  wtdc::need ssh-keygen
  wtdc::need node
  wtdc::need timeout
}

# Load defaults, then the user's config.env, seeding the user copy on first run.
# Precedence is env > config file > shipped default, so the plugin stays
# scriptable: `WTDC_ON_CREATE=auto wtdc hook-created` does what it says.
wtdc::load_config() {
  local defaults="$WTDC_ROOT/config/config.default.env"
  local user_dir="${HERDR_PLUGIN_CONFIG_DIR:-}"
  local user_file="${user_dir:+$user_dir/config.env}"
  local -A preset=()
  local k
  for k in ${!WTDC_@}; do
    preset["$k"]="${!k}"
  done

  if [ -n "$user_file" ]; then
    mkdir -p "$user_dir"
    if [ ! -f "$user_file" ] && [ -f "$defaults" ]; then
      cp "$defaults" "$user_file"
    fi
  fi

  [ -f "$defaults" ] && { set -a; . "$defaults"; set +a; }
  [ -f "$user_file" ] && { set -a; . "$user_file"; set +a; }

  for k in "${!preset[@]}"; do
    printf -v "$k" '%s' "${preset[$k]}"
  done

  : "${WTDC_ENABLED:=1}"
  : "${WTDC_ON_CREATE:=prompt}"
  : "${WTDC_SSH_FEATURE:=ghcr.io/devcontainers/features/sshd:1}"
  : "${WTDC_SSH_PORT:=2222}"
  : "${WTDC_CONTAINER_INSTALL:=}"
  : "${WTDC_REMOTE_SESSION:=}"
  : "${WTDC_OPEN_REMOTE_WORKSPACE:=1}"
  : "${WTDC_READY_TIMEOUT:=180}"
  : "${WTDC_BUILD_TIMEOUT:=1800}"
  : "${WTDC_KEEP_CONTAINER:=0}"
  : "${WTDC_EXTRA_MOUNTS:=}"
  : "${WTDC_CONFIG_CANDIDATES:=.devcontainer/devcontainer.json .devcontainer.json}"
  : "${WTDC_MACHINE_LABEL_PREFIX:=devc}"

  export WTDC_ENABLED WTDC_ON_CREATE WTDC_SSH_FEATURE WTDC_SSH_PORT \
    WTDC_CONTAINER_INSTALL WTDC_REMOTE_SESSION WTDC_OPEN_REMOTE_WORKSPACE \
    WTDC_READY_TIMEOUT WTDC_BUILD_TIMEOUT WTDC_KEEP_CONTAINER \
    WTDC_EXTRA_MOUNTS WTDC_CONFIG_CANDIDATES WTDC_MACHINE_LABEL_PREFIX
}

# Filesystem-safe, collision-resistant slug for a worktree label.
wtdc::slug() {
  local raw="$1"
  local slug
  slug="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')"
  [ -n "$slug" ] || slug=wt
  printf '%s' "${slug:0:40}"
}

wtdc::state_dir() {
  printf '%s' "${HERDR_PLUGIN_STATE_DIR:?HERDR_PLUGIN_STATE_DIR is not set}"
}

# Read the worktree facts out of a herdr event payload.
# The envelope is {"event": "...", "data": {...}} but be tolerant of a bare
# data object so a future payload tweak does not silently break the hook.
wtdc::event_field() {
  local json="$1" expr="$2"
  printf '%s' "$json" | jq -r "($expr) // empty" 2>/dev/null || true
}

wtdc::event_worktree_path() {
  wtdc::event_field "$1" '.data.worktree.path // .worktree.path // .data.workspace.worktree.checkout_path // .workspace.worktree.checkout_path'
}

wtdc::event_workspace_id() {
  wtdc::event_field "$1" '.data.workspace.workspace_id // .workspace.workspace_id // .data.workspace_id // .workspace_id'
}

wtdc::event_worktree_label() {
  wtdc::event_field "$1" '.data.worktree.label // .worktree.label'
}

wtdc::event_repo_root() {
  wtdc::event_field "$1" '.data.workspace.worktree.repo_root // .workspace.worktree.repo_root'
}

wtdc::event_repo_name() {
  wtdc::event_field "$1" '.data.workspace.worktree.repo_name // .workspace.worktree.repo_name'
}
