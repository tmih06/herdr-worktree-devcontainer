#!/usr/bin/env bash
# devcontainer.json discovery, merge, up/down.
#
# The merge exists because two things must be true before Herdr can talk to a
# container, and neither can be asked for on the devcontainer CLI command line:
#   1. sshd must be installed  -> inject the sshd feature
#   2. sshd must be reachable  -> `devcontainer up` ignores forwardPorts, so the
#                                 port has to be published with runArgs
#
# The merged copy goes to the plugin state dir, not next to the original: the
# CLI rejects any --config file not named devcontainer.json. Host-relative
# paths are rewritten to absolute so the build still resolves.

if [ -n "${WTDC_DC_SH_LOADED:-}" ]; then
  return 0
fi
WTDC_DC_SH_LOADED=1

# shellcheck source=lib/state.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/state.sh"


# dc::find_config <worktree_path> -> path of the repo's devcontainer config
dc::find_config() {
  local root="$1" candidate
  for candidate in $WTDC_CONFIG_CANDIDATES; do
    # shellcheck disable=SC2086
    if [ -f "$root/$candidate" ]; then
      printf '%s' "$root/$candidate"
      return 0
    fi
  done
  return 1
}

# The devcontainer CLI refuses any --config file not literally named
# devcontainer.json or .devcontainer.json, so the merged copy cannot simply sit
# next to the original under a new name. It goes to the plugin state dir
# instead, and every host-relative path in it is rewritten to absolute first so
# nothing depends on the new location. Side benefit: the worktree stays pristine.
dc::merged_dir_for() {
  local src="$1"
  local key
  key="$(printf '%s' "$src" | tr -c 'A-Za-z0-9' '_' | cut -c1-60)"
  printf '%s/merged/%s' "$(wtdc::state_dir)" "$key"
}

dc::merged_path_for() {
  local dir
  dir="$(dc::merged_dir_for "$1")"
  mkdir -p "$dir"
  printf '%s/devcontainer.json' "$dir"
}

# dc::build_merged <src.jsonc> <out.json> <pubkey>
dc::build_merged() {
  local src="$1" out="$2" pubkey="$3"
  local plain
  plain="$(mktemp)"

  node "$WTDC_ROOT/bin/jsonc2json.js" "$src" "$plain" || {
    rm -f "$plain"
    return 1
  }

  if ! jq \
    --arg feature "$WTDC_SSH_FEATURE" \
    --arg pubkey "$pubkey" \
    --arg install "$WTDC_CONTAINER_INSTALL" \
    --arg cport "$WTDC_SSH_PORT" \
    '
    # The Dev Container CLI joins postCreateCommand array items with a space and
    # execs the result as one command line, so an array is NOT a safe way to
    # append work. Always emit a single string chained with &&.
    def as_cmd_string:
      if type == "string" then .
      elif type == "array" then (map(tostring) | join(" && "))
      elif type == "object" then
        error("object-form postCreateCommand cannot be merged safely")
      elif type == "null" then ""
      else tostring end;

    .features = (.features // {})
    | (if (.features | has($feature)) then . else .features[$feature] = {} end)
    | (if (.dockerComposeFile // null) != null then
         error("compose-based devcontainer configs cannot take runArgs")
       else . end)
    | .runArgs = ((.runArgs // [])
                  + (if ((.runArgs // []) | index("--publish")) then []
                     else ["--publish", "127.0.0.1::" + $cport] end))
    | .postCreateCommand = (
        [
          (.postCreateCommand // null | as_cmd_string),
          # postCreateCommand runs as the devcontainer remoteUser, which is not
          # the USER of the image (that is often root). Record who we actually
          # provisioned so the SSH login matches the account we set up.
          ("id -un > /tmp/wtdc-user"
           + " && mkdir -p \"$HOME/.ssh\""
           + " && echo \"" + $pubkey + "\""
           + " >> \"$HOME/.ssh/authorized_keys\""
           + " && chmod 700 \"$HOME/.ssh\""
           + " && chmod 600 \"$HOME/.ssh/authorized_keys\""),
          ("( " + $install + " ) || echo \"WTDC: herdr install failed inside the container\"")
        ]
        | map(select(. != ""))
        | join(" && ")
      )
    ' "$plain" >"$out"; then
    rm -f "$plain"
    return 1
  fi

  rm -f "$plain"

  # The merged copy lives outside the worktree, so every host-relative path
  # has to be pinned to an absolute one or the build would look in the wrong
  # place. Paths inside the container (workspaceFolder, workspaceMount) are
  # untouched on purpose.
  dc::absolutize_paths "$out" "$(dirname "$src")"
  jq -e . "$out" >/dev/null
}

dc::absolutize_paths() {
  local out="$1" base="$2" ctx df ext tmp
  tmp="$(mktemp)"

  ctx="$(jq -r '.build.context // empty' "$out" 2>/dev/null || true)"
  if [ -n "$ctx" ]; then
    ctx="$(realpath -m "$base/$ctx")"
    df="$(jq -r '.build.dockerfile // .dockerFile // empty' "$out" 2>/dev/null || true)"
    # build.dockerfile is relative to build.context, not to the config file.
    [ -n "$df" ] && df="$(realpath -m "$ctx/$df")"
    if jq --arg c "$ctx" --arg d "$df" '
          .build.context = $c
          | (if $d == "" then . else .build.dockerfile = $d end)
        ' "$out" >"$tmp" 2>/dev/null; then
      mv -f "$tmp" "$out"
    else
      rm -f "$tmp"; tmp=""
    fi
  fi

  [ -n "$tmp" ] || tmp="$(mktemp)"
  ext="$(jq -r '.extends // empty' "$out" 2>/dev/null || true)"
  if [ -n "$ext" ] && [ "${ext:0:1}" != "http" ]; then
    if jq --arg e "$(realpath -m "$base/$ext")" '.extends = $e' "$out" >"$tmp" 2>/dev/null; then
      mv -f "$tmp" "$out"
    fi
  fi
  rm -f "$tmp"
}

# dc::container_for <worktree_path> -> container id from the devcontainer label
dc::container_for() {
  local wt="$1"
  docker ps -aq --filter "label=devcontainer.local_folder=$wt" 2>/dev/null | head -1
}

# dc::up <worktree> <merged_config> -> container id on stdout
# stderr is left attached so the build log streams into the plugin's pane.
dc::up() {
  local wt="$1" cfg="$2" outf rc cid
  outf="$(mktemp)"

  local args=(
    up
    --workspace-folder "$wt"
    --config "$cfg"
    --remove-existing-container
  )
  [ -n "$WTDC_EXTRA_MOUNTS" ] && args+=(--mount "$WTDC_EXTRA_MOUNTS")

  set +e
  timeout "$WTDC_BUILD_TIMEOUT" devcontainer "${args[@]}" >"$outf"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if [ -s "$outf" ]; then
      printf '\n'
      cat "$outf"
    fi
    rm -f "$outf"
    if [ "$rc" -eq 124 ]; then
      wtdc::die "devcontainer up timed out after ${WTDC_BUILD_TIMEOUT}s"
    fi
    wtdc::die "devcontainer up failed (exit $rc)"
  fi

  cid="$(jq -r '.containerId // empty' "$outf" 2>/dev/null | tail -1)"
  if [ -z "$cid" ]; then
    cid="$(dc::container_for "$wt")"
  fi
  local remote_ws
  remote_ws="$(jq -r '.remoteWorkspaceFolder // empty' "$outf" 2>/dev/null | tail -1)"
  rm -f "$outf"

  [ -n "$cid" ] || wtdc::die "devcontainer up succeeded but no container id could be determined"
  printf '%s' "$cid"
  [ -n "$remote_ws" ] && printf '\n%s' "$remote_ws"
  return 0
}

# dc::down <worktree> <merged_config> <container_id>
dc::down() {
  local wt="$1" cfg="$2" cid="$3" rc

  if [ -f "$cfg" ]; then
    set +e
    timeout 300 devcontainer down \
      --workspace-folder "$wt" \
      --config "$cfg" \
      --remove-existing-container
    rc=$?
    set -e
  else
    rc=1
  fi

  # devcontainer down can refuse (stale config, compose project renamed). The
  # container itself is what we actually care about removing.
  if [ -n "$cid" ] && docker ps -aq --filter "id=$cid" | grep -q .; then
    set +e
    docker rm -f "$cid" >/dev/null 2>&1
    set -e
  fi
  return 0
}

