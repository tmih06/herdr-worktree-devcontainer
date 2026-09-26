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
    --arg prebuilt "$(dc::prebuilt_image)" \
    --arg ruser "${WTDC_IMAGE_REMOTE_USER:-}" \
    --arg plugindir "$(dc::plugin_share_dir)" \
    --arg skipuid "$(dc::image_uid_matches_host && echo yes || echo no)" \
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

    # A prebuilt image already has sshd and herdr, and declaring ANY feature
    # makes the CLI derive a per-workspace image, which is the cost we are here
    # to avoid. So on the prebuilt path features are dropped outright, not just
    # the one we would have injected: leaving a single feature in place still
    # costs a full build. dc::build_merged warns about anything it drops.
    (if $prebuilt == "" then
       (.features = (.features // {})
        | (if (.features | has($feature)) then . else .features[$feature] = {} end))
     else . end)
    | (if $prebuilt != "" and (.features // {} | length) > 0
       then .features = {} else . end)
    | (if $prebuilt != "" then .image = $prebuilt else . end)
    | (if $prebuilt != "" and ($ruser | length) > 0 then .remoteUser = $ruser else . end)
    # Skip the uid remap only when the image already ships the host uid, and
    # only for a prebuilt image. Getting this wrong means an unwritable
    # workspace, so never guess it from anything but the image label.
    | (if $prebuilt != "" and $skipuid == "yes" then .updateRemoteUserUID = false else . end)
    | (if (.dockerComposeFile // null) != null then
         error("compose-based devcontainer configs cannot take runArgs")
       else . end)
    | .runArgs = ((.runArgs // [])
                  + (if ((.runArgs // []) | index("--publish")) then []
                     else ["--publish", "127.0.0.1::" + $cport] end))
    | .remoteEnv = ((.remoteEnv // {}) + {WTDC_IN_CONTAINER: "1"})
    | .postCreateCommand = (
        (
          [
            (.postCreateCommand // null | as_cmd_string),
            # sshd is deliberately NOT started here. Anything this command
            # leaves running inherits the devcontainer CLI stdout pipe and
            # holds it open, so the CLI waits for EOF that never arrives and
            # `up` hangs until its own timeout. The plugin starts sshd with
            # `docker exec -d` after `up` returns, which is fully detached.
            ("id -un > /tmp/wtdc-user"
             + " && mkdir -p \"$HOME/.ssh\""
             + " && echo \"" + $pubkey + "\""
             + " >> \"$HOME/.ssh/authorized_keys\""
             + " && chmod 700 \"$HOME/.ssh\""
             + " && chmod 600 \"$HOME/.ssh/authorized_keys\"")
          ]
          # The shared plugins land at the host absolute path, which is not
          # the home of the container user, so link them where the container
          # herdr will actually look. No-op when the mount is absent.
          + (if $plugindir == "" then []
             else
               ["if [ -d \"" + $plugindir + "\" ]; then"
                + " mkdir -p \"$HOME/.config/herdr\""
                + " && ln -sfn \"" + $plugindir + "\" \"$HOME/.config/herdr/plugins\""
                + "; fi"]
             end)
          # Only download when there is no herdr to use. When the plugin bind
          # mounts a herdr binary, `command -v` finds it and the ~30s download
          # is skipped; if the mount is missing (compose configs take no
          # --mount) this still installs. The braces are load-bearing: `a || b
          # && c` is left-associative, so without them the download would run
          # even when `a` succeeded. Keep the output too: a network blip during
          # image setup otherwise fails silently.
          + (if $install == "" then []
             else
              ["( command -v herdr >/dev/null 2>&1 || { " + $install + " ; }"
               + " ) > /tmp/wtdc-install.log 2>&1"
               + " || echo \"WTDC: herdr install failed inside the container,"
               + " see /tmp/wtdc-install.log\""]
            end)
        )
         | map(select(. != ""))
         | join(" && ")
       )
    ' "$plain" >"$out"; then
    rm -f "$plain"
    return 1
  fi

  # Dropping a user's declared features changes what their container contains,
  # so never do it quietly. The prebuilt templates are expected to already
  # provide them. Read the source before it is cleaned up.
  local prebuilt dropped
  prebuilt="$(dc::prebuilt_image)"
  if [ -n "$prebuilt" ]; then
    dropped="$(jq -r '(.features // {}) | keys | join(", ")' "$plain" 2>/dev/null || true)"
    if [ -n "$dropped" ]; then
      wtdc::warn "using prebuilt image $prebuilt, so these features are not applied: $dropped"
      wtdc::detail "pick a template that already includes them, or unset WTDC_IMAGE/WTDC_TEMPLATE to keep them"
    fi
  fi

  rm -f "$plain"
  # The merged copy lives outside the worktree, so every host-relative path
  # has to be pinned to an absolute one or the build would look in the wrong
  # place. Paths inside the container (workspaceFolder, workspaceMount) are
  # untouched on purpose.
  dc::absolutize_paths "$out" "$(dirname "$src")"
  jq -e . "$out" >/dev/null
}

# Resolve the image to run instead of building one.
#
#   WTDC_IMAGE=ghcr.io/me/img:tag   use exactly this
#   WTDC_TEMPLATE=node              resolve via images/manifest.json
#   (unset)                          fall back to injecting the sshd feature
#
# A prebuilt image declares no `features`, so the devcontainer CLI does not
# derive a per-workspace image and `up` is just `docker run`. That is the whole
# reason this path exists.
dc::prebuilt_image() {
  if [ -n "${WTDC_IMAGE:-}" ]; then
    printf '%s' "$WTDC_IMAGE"
    return 0
  fi
  local tpl="${WTDC_TEMPLATE:-}"
  [ -n "$tpl" ] || return 0
  local manifest="$WTDC_ROOT/images/manifest.json"
  if [ ! -f "$manifest" ]; then
    wtdc::warn "WTDC_TEMPLATE=$tpl but $manifest is missing"
    return 0
  fi
  local tag ref
  tag="$(jq -r '.tag // "latest"' "$manifest")"
  ref="$(jq -r --arg n "$tpl" --arg t "$tag" '
    (.images | map(select(.name == $n)) | .[0].name) as $hit
    | if $hit == null then "" else (.registry + "/" + .prefix + "-" + $hit + ":" + $t) end
  ' "$manifest")"
  if [ -z "$ref" ]; then
    wtdc::warn "WTDC_TEMPLATE=$tpl is not in images/manifest.json"
    return 0
  fi
  printf '%s' "$ref"
}

# Does this image need the uid remap at all?
#
# The CLI derives a `vsc-<folder>-<hash>-uid` copy of the image whose remote
# user matches the host uid, so bind-mounted files are writable. That copy is
# a full image: when the uids already agree it is a pointless 300MB duplicate,
# and its updateUID script silently does nothing anyway.
#
# The templates label themselves with the uid they ship, so the answer is one
# cheap `docker image inspect` instead of a container run. Any host that is not
# uid 1000 still gets the remap, which now actually works because the image
# leaves uid 1000 free.
dc::image_uid_matches_host() {
  local ref label_uid host_uid
  ref="$(dc::prebuilt_image)"
  [ -n "$ref" ] || return 1
  label_uid="$(docker image inspect "$ref" \
    --format '{{index .Config.Labels "devcontainer.remote.uid"}}' 2>/dev/null || true)"
  [ -n "$label_uid" ] || return 1
  host_uid="$(id -u)"
  [ "$label_uid" = "$host_uid" ]
}

# Pull before `up` so the first provision of a template does not pay for the
# pull inside the build step.
dc::prepull_image() {
  local ref
  ref="$(dc::prebuilt_image)"
  [ -n "$ref" ] || return 0
  docker image inspect "$ref" >/dev/null 2>&1 && return 0
  wtdc::step "Pulling $ref"
  docker pull "$ref" >/dev/null 2>&1 ||
    wtdc::warn "could not pull $ref; devcontainer will retry during up"
  return 0
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

# The host already has a herdr binary, so reuse it instead of downloading 26MB
# on every provision (measured at ~31s). The devcontainer CLI's --mount only
# accepts type/source/target/external, with no read-only option, so mounting
# the host's live binary would hand the container write access to it. Mount a
# cache copy instead: the worst a container can do is corrupt the cache, which
# is rebuilt from the host binary whenever it stops being runnable.
dc::herdr_share_mount() {
  case "${WTDC_SHARE_HERDR_BIN:-auto}" in
    0 | false | no) return 0 ;;
  esac
  [ "$(uname -s)" = "Linux" ] || return 0
  local host_bin cache
  host_bin="${HERDR_BIN_PATH:-}"
  if [ -z "$host_bin" ] || [ ! -x "$host_bin" ]; then
    host_bin="$(command -v herdr 2>/dev/null || true)"
  fi
  [ -n "$host_bin" ] && [ -x "$host_bin" ] || return 0

  cache="$(wtdc::state_dir)/cache/herdr"
  mkdir -p "$(dirname "$cache")"
  # Refresh when missing, or when a container-corrupted copy no longer runs.
  if [ ! -x "$cache" ] || ! "$cache" --version >/dev/null 2>&1; then
    cp -f "$host_bin" "$cache" 2>/dev/null || return 0
    chmod +x "$cache" 2>/dev/null || return 0
  fi
  printf 'type=bind,source=%s,target=/usr/local/bin/herdr' "$cache"
}

# Share the host's installed plugins so the same tooling works in the
# container. This plugin's own code lives in its repo rather than here, so it is
# not carried across; WTDC_IN_CONTAINER is the hard guard that makes the
# no-recursion rule explicit instead of incidental.
dc::plugin_share_dir() {
  case "${WTDC_SHARE_HERDR_PLUGINS:-auto}" in
    0 | false | no) return 0 ;;
  esac
  local d="${HERDR_CONFIG_PATH:-$HOME/.config/herdr}/plugins"
  [ -d "$d" ] || return 0
  # Never expose this plugin's state dir: it holds the SSH private key.
  case "$(wtdc::state_dir)" in
    "$d"/*) return 0 ;;
  esac
  printf '%s' "$d"
}

dc::plugin_share_mount() {
  local d
  d="$(dc::plugin_share_dir)"
  [ -n "$d" ] || return 0
  printf 'type=bind,source=%s,target=%s' "$d" "$d"
}

# Remove any container still labelled with this workspace, regardless of
# whether the plugin has state for it.
#
# A provisioning that fails after `devcontainer up` succeeded leaves a running
# container behind, and the failure path deliberately drops the state entry so
# the worktree stays retryable. That is right for retrying, but it means a later
# `worktree.removed` finds no state and used to leave the container to docker's
# own pruning. The devcontainer label is the authority here, not our bookkeeping.
dc::remove_orphans() {
  local wt="$1" c removed=0
  for c in $(docker ps -aq --filter "label=devcontainer.local_folder=$wt" 2>/dev/null); do
    if docker rm -f "$c" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done
  if [ "$removed" -gt 0 ]; then
    wtdc::ok "removed $removed orphaned container(s) for $wt"
  fi
  return 0
}

# Has postCreateCommand finished? The first thing it does is record the user it
# provisioned, so that file appearing is the signal that authorized_keys is
# written and the container is ready to be talked to.
dc::postcreate_done() {
  local cid="$1"
  docker exec "$cid" sh -lc '[ -f /tmp/wtdc-user ]' >/dev/null 2>&1
}

# dc::container_for <worktree_path> -> container id from the devcontainer label
dc::container_for() {
  local wt="$1"
  docker ps -aq --filter "label=devcontainer.local_folder=$wt" 2>/dev/null | head -1
}

# dc::up <worktree> <merged_config> -> container id on stdout
#
# Deliberately does not simply block on `devcontainer up` returning. The CLI
# leaves a foreground `docker run` attached to the container, and that process
# does not always exit even though the container is fully up and usable: the
# CLI was observed still waiting 11 minutes after /tmp/wtdc-user existed and
# sshd was accepting connections. Waiting on the CLI therefore meant freezing
# with a working container on screen.
#
# So: run it in the background, wait for the *state we actually need* (the
# container exists, and postCreateCommand has written its marker), then stop
# waiting and reclaim the CLI process.
dc::up() {
  local wt="$1" cfg="$2" outf rc=0 cid waited=0 cli_pid
  outf="$(mktemp)"
  dc::prepull_image

  local args=(
    up
    --workspace-folder "$wt"
    --config "$cfg"
    --remove-existing-container
  )
  [ -n "$WTDC_EXTRA_MOUNTS" ] && args+=(--mount "$WTDC_EXTRA_MOUNTS")

  # Reuse what the host already has instead of re-downloading per container.
  # Both are optimisations only: the injected postCreateCommand installs herdr
  # whenever no herdr is on PATH, so a missing or unusable mount still works.
  local share
  share="$(dc::herdr_share_mount)"
  [ -n "$share" ] && args+=(--mount "$share")
  share="$(dc::plugin_share_mount)"
  [ -n "$share" ] && args+=(--mount "$share")

  set +e
  devcontainer "${args[@]}" >"$outf" 2>&1 &
  cli_pid=$!

  while [ "$waited" -lt "$WTDC_BUILD_TIMEOUT" ]; do
    cid="$(dc::container_for "$wt")"
    if [ -n "$cid" ] && dc::postcreate_done "$cid"; then
      break
    fi
    if ! kill -0 "$cli_pid" 2>/dev/null; then
      wait "$cli_pid"
      rc=$?
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Whatever state we reached, do not leave the CLI holding the container.
  if kill -0 "$cli_pid" 2>/dev/null; then
    wtdc::detail "devcontainer CLI is still holding the container; detaching it"
    # Only the CLI. The `docker run` it spawned is how the container stays
    # alive, exactly as an editor client would leave it, so killing the whole
    # process group would take the container's stdio with it.
    kill -TERM "$cli_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$cli_pid" 2>/dev/null || true
  fi
  set -e

  # stdout and stderr share the file, so the payload is the last line that
  # actually parses as JSON. Anything else would make jq fail and, under
  # set -e, kill the script with no message at all.
  local payload
  payload="$(grep -E '^\{' "$outf" 2>/dev/null | tail -1 || true)"
  cid="$(printf '%s' "$payload" | jq -r '.containerId // empty' 2>/dev/null || true)"
  [ -n "$cid" ] || cid="$(dc::container_for "$wt" || true)"

  if [ -z "$cid" ]; then
    [ -s "$outf" ] && { printf '\n'; cat "$outf"; }
    rm -f "$outf"
    wtdc::die "devcontainer up did not produce a container"
  fi

  local remote_ws
  remote_ws="$(printf '%s' "$payload" | jq -r '.remoteWorkspaceFolder // empty' 2>/dev/null || true)"
  rm -f "$outf"

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

