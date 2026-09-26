#!/usr/bin/env bash
# Durable plugin state, owned entirely by the plugin (herdr provides only the
# directory). One JSON document keyed by worktree checkout path.
#
#   { "version": 1,
#     "entries": {
#       "/home/me/.herdr/worktrees/feat": {
#         "label": "devc-feat", "slug": "feat", "container_id": "abc",
#         "ssh_alias": "herdr-devc-feat", "ssh_host": "127.0.0.1",
#         "ssh_port": "32771", "ssh_user": "vscode",
#         "endpoint_kind": "published-port",
#         "remote_workspace": "/workspaces/feat", "machine_id": "m3",
#         "merged_config": "/.../herdr-devcontainer.json",
#         "source_config": "/.../devcontainer.json"
#       }
#     } }

if [ -n "${WTDC_STATE_SH_LOADED:-}" ]; then
  return 0
fi
WTDC_STATE_SH_LOADED=1

# shellcheck source=lib/common.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

state::file() {
  printf '%s/state.json' "$(wtdc::state_dir)"
}

state::init() {
  local f
  f="$(state::file)"
  mkdir -p "$(dirname "$f")"
  if [ ! -f "$f" ]; then
    printf '{"version":1,"entries":{}}\n' >"$f"
  fi
}

# state::get <checkout_path> -> compact JSON on stdout, empty when absent
state::get() {
  local key="$1"
  state::init
  jq -c --arg k "$key" '.entries[$k] // empty' "$(state::file)"
}

state::has() {
  [ -n "$(state::get "$1")" ]
}

# state::set <checkout_path> <json-object>
# Writes to a sibling temp file and renames, so a crash cannot leave a
# half-written state file behind.
state::set() {
  local key="$1" value="$2" f tmp
  f="$(state::file)"
  state::init
  tmp="$(mktemp "${f}.XXXXXX")"
  if ! jq --arg k "$key" --argjson v "$value" \
    '.entries[$k] = $v' "$f" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    wtdc::die "state::set: value for '$key' is not valid JSON"
  fi
  mv -f "$tmp" "$f"
}

# state::patch <checkout_path> <filter> [extra jq args...]
state::patch() {
  local key="$1" filter="$2"; shift 2
  local f tmp
  f="$(state::file)"
  state::init
  [ -n "$(state::get "$key")" ] || return 1
  tmp="$(mktemp "${f}.XXXXXX")"
  if ! jq --arg k "$key" "$@" "$filter" "$f" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    wtdc::die "state::patch: filter failed for '$key'"
  fi
  mv -f "$tmp" "$f"
}

state::del() {
  local key="$1" f tmp
  f="$(state::file)"
  state::init
  tmp="$(mktemp "${f}.XXXXXX")"
  jq --arg k "$key" 'del(.entries[$k])' "$f" >"$tmp"
  mv -f "$tmp" "$f"
}

# state::list -> one compact JSON object per line
state::list() {
  state::init
  jq -c '.entries | to_entries[] | .value + {checkout_path: .key}' "$(state::file)"
}

# state::find_by_container <container_id>
state::find_by_container() {
  local cid="$1"
  state::init
  jq -c --arg c "$cid" \
    '.entries | to_entries[] | select(.value.container_id == $c) | .value + {checkout_path: .key}' \
    "$(state::file)"
}
