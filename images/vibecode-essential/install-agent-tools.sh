#!/usr/bin/env bash
# Unpinned agent tooling: every install resolves the latest upstream release
# at image build time. Runs as root during docker build; lands in
# /usr/local/bin (or npm's global prefix) so the dev user can run all of it.
set -euo pipefail

# Asset spellings per upstream, keyed on the dpkg architecture.
case "$(dpkg --print-architecture)" in
  amd64)
    rust_arch=x86_64   # rtk, lazygitrs, btop
    rtk_libc=musl      # rtk's x86_64 linux build is musl; its arm64 build is gnu
    omp_arch=x64       # oh-my-pi release binaries
    cbm_arch=amd64     # codebase-memory-mcp
    ld_arch=x86_64     # lazydocker
    direnv_arch=amd64
    ci_arch=amd64      # wakatime-cli, circleci
    ;;
  arm64)
    rust_arch=aarch64
    rtk_libc=gnu
    omp_arch=arm64
    cbm_arch=arm64
    ld_arch=arm64
    direnv_arch=arm64
    ci_arch=arm64      # wakatime-cli, circleci
    ;;
  *) echo 'Only linux/amd64 and linux/arm64 are supported' >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

latest_asset() { # repo file
  curl -fsSLO "https://github.com/$1/releases/latest/download/$2"
}

verify_sum() { # sums-file archive
  grep " $2\$" "$1" | sha256sum --check -
}

# omp — the oh-my-pi coding agent. The npm package's bin is a bun-compiled
# bundle (`#!/usr/bin/env bun`, engines bun>=1.3.14), so the self-contained
# release binary is the correct upstream artifact here, same as upstream's
# `install.sh --binary` mode.
latest_asset can1357/oh-my-pi "omp-linux-${omp_arch}"
latest_asset can1357/oh-my-pi SHA256SUMS.txt
verify_sum SHA256SUMS.txt "omp-linux-${omp_arch}"
install -m 0755 "omp-linux-${omp_arch}" /usr/local/bin/omp

# rtk — Rust Token Killer (rtk-ai/rtk). NOT the npm `rtk` package, which is an
# unrelated changelog release tool from cliffano.
rtk_archive="rtk-${rust_arch}-unknown-linux-${rtk_libc}.tar.gz"
latest_asset rtk-ai/rtk "$rtk_archive"
latest_asset rtk-ai/rtk checksums.txt
verify_sum checksums.txt "$rtk_archive"
mkdir rtk && tar -xzf "$rtk_archive" -C rtk
install -m 0755 rtk/rtk /usr/local/bin/rtk

# lazygitrs — Rust lazygit rewrite (Blankeos/lazygitrs), crates.io name matches.
lg_archive="lazygitrs-${rust_arch}-unknown-linux-gnu.tar.xz"
latest_asset Blankeos/lazygitrs "$lg_archive"
latest_asset Blankeos/lazygitrs "${lg_archive}.sha256"
sha256sum --check "${lg_archive}.sha256"
tar -xJf "$lg_archive"
install -m 0755 "lazygitrs-${rust_arch}-unknown-linux-gnu/lazygitrs" /usr/local/bin/lazygitrs

# lazydocker (jesseduffield/lazydocker). Asset names embed the version, so the
# tag is resolved from the /releases/latest redirect instead of the API.
ld_tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/jesseduffield/lazydocker/releases/latest)"
ld_tag="${ld_tag##*/}"
ld_archive="lazydocker_${ld_tag#v}_Linux_${ld_arch}.tar.gz"
curl -fsSLO "https://github.com/jesseduffield/lazydocker/releases/download/${ld_tag}/${ld_archive}"
curl -fsSLo ld-checksums.txt "https://github.com/jesseduffield/lazydocker/releases/download/${ld_tag}/checksums.txt"
verify_sum ld-checksums.txt "$ld_archive"
mkdir lazydocker && tar -xzf "$ld_archive" -C lazydocker
install -m 0755 lazydocker/lazydocker /usr/local/bin/lazydocker

# btop — upstream ships static musl binaries and no checksums file.
latest_asset aristocratos/btop "btop-${rust_arch}-unknown-linux-musl.tar.gz"
mkdir btop && tar -xzf "btop-${rust_arch}-unknown-linux-musl.tar.gz" -C btop
install -m 0755 btop/btop/bin/btop /usr/local/bin/btop

# direnv — replaces the inherited apt build; upstream releases publish no
# checksums file.
latest_asset direnv/direnv "direnv.linux-${direnv_arch}"
install -m 0755 "direnv.linux-${direnv_arch}" /usr/local/bin/direnv

# wakatime-cli — Go binary at the zip root, checksums in one release-wide file.
waka_archive="wakatime-cli-linux-${ci_arch}.zip"
latest_asset wakatime/wakatime-cli "$waka_archive"
latest_asset wakatime/wakatime-cli checksums_sha256.txt
verify_sum checksums_sha256.txt "$waka_archive"
mkdir wakatime && unzip -q "$waka_archive" -d wakatime
install -m 0755 "wakatime/wakatime-cli-linux-${ci_arch}" /usr/local/bin/wakatime-cli

# circleci — the version is embedded in the archive name, so the tag comes from
# the /releases/latest redirect rather than the API.
cci_version="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/CircleCI-Public/circleci-cli/releases/latest)"
cci_version="${cci_version##*/}"
cci_version="${cci_version#v}"
cci_archive="circleci-cli_${cci_version}_linux_${ci_arch}.tar.gz"
curl -fsSLO "https://github.com/CircleCI-Public/circleci-cli/releases/download/v${cci_version}/${cci_archive}"
curl -fsSLo cci-checksums.txt "https://github.com/CircleCI-Public/circleci-cli/releases/download/v${cci_version}/circleci-cli_${cci_version}_checksums.txt"
verify_sum cci-checksums.txt "$cci_archive"
tar -xzf "$cci_archive" circleci
install -m 0755 circleci /usr/local/bin/circleci

# codebase-memory-mcp (DeusData). Linux has a fully-static "-portable" build;
# upstream's own install.sh prefers it, so we take the same asset but verify
# and place the binary directly — the interactive installer also edits agent
# configs, PATH files, and starts activation machinery meant for user shells.
cbm_archive="codebase-memory-mcp-linux-${cbm_arch}-portable.tar.gz"
latest_asset DeusData/codebase-memory-mcp "$cbm_archive"
latest_asset DeusData/codebase-memory-mcp checksums.txt
verify_sum checksums.txt "$cbm_archive"
mkdir cbm && tar -xzf "$cbm_archive" -C cbm
install -m 0755 cbm/codebase-memory-mcp /usr/local/bin/codebase-memory-mcp

# codebase-memory-session-mcp — the per-session stdio front end for
# codebase-memory-mcp: joins or owns the shared cache, pre-indexes the
# session cwd in the background, tracks per-project session locks, and
# releases the index when the last client disconnects. Upstream ships no
# separate artifact; this wrapper supervises the installed binary.
cat > /usr/local/bin/codebase-memory-session-mcp <<'SESSION_WRAPPER'
#!/usr/bin/env bash
# Session wrapper for codebase-memory-mcp: join the live shared cache,
# ensure the session working directory is indexed on connect, and release
# the project index when the last client for it disconnects.
#
# Behavior:
# - Joins CBM_CACHE_DIR when already set, else discovers the active
#   ephemeral daemon cache under /run/user/$UID, else falls back to the
#   persistent default (~/.cache/codebase-memory-mcp). Never rm -rf a
#   cache it does not own, so concurrent agents are not interrupted.
# - Pre-indexes $CBM_REPO_PATH (default: $PWD) before starting the MCP
#   server when the project is missing. All diagnostics go to
#   stderr so MCP stdio on stdout stays clean.
# - Tracks per-project clients with lock files under the cache dir. When
#   the last lock for a project is removed on session exit, deletes that
#   project index. Whole-cache deletion only happens for temp caches this
#   wrapper created itself (CBM_EPHEMERAL=1).
set -euo pipefail

readonly CBM_BIN="/usr/local/bin/codebase-memory-mcp"
readonly PERSISTENT_CACHE="${HOME:-/root}/.cache/codebase-memory-mcp"
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
readonly UID_DIR="/run/user/$(id -u)"

# Resolve the session repo path: explicit override wins, else cwd.
# Output: prints the absolute repo path.
repo_path() {
  local p
  if [[ -n "${CBM_REPO_PATH:-}" ]]; then
    p="$(cd "${CBM_REPO_PATH}" 2>/dev/null && pwd -P)" || p="${CBM_REPO_PATH}"
  else
    p="$(pwd -P)"
  fi
  printf '%s' "${p%/}"
}

# Discover the active daemon or client cache dir, if any.
# Output: prints the cache dir path, or nothing when none found.
discover_active_cache() {
  local pid cache
  # 1. Check for running CBM daemon
  for pid in $(pgrep -u "$(id -u)" -f "codebase-memory-mcp.*--cbm-daemon-internal" 2>/dev/null); do
    cache="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep '^CBM_CACHE_DIR=' | cut -d= -f2- || true)"
    if [[ -n "${cache}" && -d "${cache}" ]]; then
      printf '%s\n' "${cache}"
      return 0
    fi
  done
  # 2. Check for running CBM client processes
  for pid in $(pgrep -u "$(id -u)" -f "codebase-memory" 2>/dev/null); do
    [[ "${pid}" != "$$" ]] || continue
    [[ -r "/proc/${pid}/environ" ]] || continue
    cache="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep '^CBM_CACHE_DIR=' | cut -d= -f2- || true)"
    if [[ -n "${cache}" && -d "${cache}" ]]; then
      printf '%s\n' "${cache}"
      return 0
    fi
  done
  return 1
}

# Discover the newest live ephemeral cache dir by mtime, if any.
# Output: prints the cache dir path, or nothing when none found.
discover_ephemeral_cache() {
  local candidate
  for candidate in $(ls -td "${UID_DIR}"/codebase-memory-mcp-omp.* "${RUNTIME_DIR}"/codebase-memory-mcp-omp.* 2>/dev/null); do
    [[ -d "${candidate}" ]] || continue
    [[ -f "${candidate}/_config.db" ]] || continue
    printf '%s\n' "${candidate}"
    return 0
  done
  return 1
}

# Decide which cache to join and whether this wrapper owns its lifetime.
# Output: prints "<cache_dir>|<owned:true|false>".
resolve_cache() {
  if [[ -n "${CBM_CACHE_DIR:-}" && -d "${CBM_CACHE_DIR}" ]]; then
    printf '%s|%s\n' "${CBM_CACHE_DIR}" "false"
    return 0
  fi
  if [[ "${CBM_EPHEMERAL:-0}" == "1" ]]; then
    umask 077
    local fresh
    fresh="$(mktemp -d "${RUNTIME_DIR}/codebase-memory-mcp-omp.XXXXXX")"
    printf '%s|%s\n' "${fresh}" "true"
    return 0
  fi
  local active
  active="$(discover_active_cache || true)"
  if [[ -n "${active}" ]]; then
    printf '%s|%s\n' "${active}" "false"
    return 0
  fi
  local live
  live="$(discover_ephemeral_cache || true)"
  if [[ -n "${live}" ]]; then
    printf '%s|%s\n' "${live}" "false"
    return 0
  fi
  printf '%s|%s\n' "${PERSISTENT_CACHE}" "false"
}

# Check whether a repo path already has a project index. Fast path only:
# legacy <cache>/<name>.db files. Daemon-managed projects live under
# /tmp/cbm-daemon-*/cbm-*.rw, NOT here, so this misses them; callers that
# need the truth must use find_project_via_daemon.
# Input: $1 repo path. Output: prints project name when found.
find_project() {
  local repo="$1" guess
  guess="$(printf '%s' "${repo#/}" | tr '/' '-')"
  if [[ -f "${CACHE_DIR}/${guess}.db" ]]; then
    printf '%s' "${guess}"
  fi
  return 0
}

# Resolve the project name for a repo path by asking the live daemon.
# list_projects prints "<name> <root_path> <branch>" rows; match root_path.
# Input: $1 repo path. Output: prints project name, or nothing on failure.
find_project_via_daemon() {
  local repo="$1" out
  out="$(CBM_CACHE_DIR="${CACHE_DIR}" timeout 15 "${CBM_BIN}" cli --quiet list_projects </dev/null 2>/dev/null || true)"
  printf '%s\n' "${out}" | awk -v repo="${repo}" '$2 == repo { print $1; exit }'
  return 0
}

# Remove lock files whose PID no longer exists, across EVERY project lock
# dir. A SIGKILLed session leaves its lock behind; without a global sweep
# the orphaned project is pinned forever because release_when_last only
# prunes the exiting session's own project.
prune_stale_locks() {
  local f pid
  for f in "${CACHE_DIR}"/.session-locks/*/*; do
    [[ -e "${f}" ]] || continue
    pid="$(basename "${f}")"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${f}" 2>/dev/null || true
    fi
  done
  # Drop now-empty lock dirs.
  local d
  for d in "${CACHE_DIR}"/.session-locks/*/; do
    [[ -d "${d}" ]] || continue
    rmdir "${d}" 2>/dev/null || true
  done
}

# Delete any indexed project that has no live session lock and no live
# client process. Runs at startup so orphans left by killed sessions are
# reaped even when no new session ever opens that repo again.
reap_orphaned_projects() {
  local out name root slug lockdir
  out="$(CBM_CACHE_DIR="${CACHE_DIR}" timeout 15 "${CBM_BIN}" cli --quiet list_projects </dev/null 2>/dev/null || true)"
  [[ -n "${out}" ]] || return 0
  while read -r name root _; do
    [[ -n "${name}" && "${root}" == /* ]] || continue
    [[ "${root}" == "${REPO}" ]] && continue   # our own repo is handled by the normal flow
    slug="$(printf '%s' "${root#/}" | tr '/' '-')"
    lockdir="${CACHE_DIR}/.session-locks/${slug}"
    if [[ -d "${lockdir}" ]] && [[ -n "$(ls -A "${lockdir}" 2>/dev/null)" ]]; then
      continue   # live lock(s) remain
    fi
    if other_clients_for_repo "${root}"; then
      continue   # a live client still holds it
    fi
    echo "cbm-session: reaping orphaned project ${name} (${root})" >&2
    CBM_CACHE_DIR="${CACHE_DIR}" timeout 60 "${CBM_BIN}" cli --quiet delete_project --project "${name}" </dev/null >&2 || true
  done <<< "$(printf '%s\n' "${out}" | awk 'NR>0 && $2 ~ /^\// { print }')"
}

# Reports whether any other live CBM session is attached to THIS repo.
# Matches the session WRAPPER (codebase-memory-session-mcp), not the bare
# MCP child: an orphaned child whose wrapper died must not pin the index.
# Output: returns 0 when another session lives in this repo, 1 otherwise.
other_clients_for_repo() {
  local repo="$1" d pid cwd
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [[ "${pid}" != "$$" ]] || continue
    [[ -n "${child_pid:-}" && "${pid}" == "${child_pid}" ]] && continue
    [[ -r "${d}/cmdline" ]] || continue
    tr '\0' ' ' < "${d}/cmdline" 2>/dev/null | grep -q "codebase-memory-session-mcp" || continue
    cwd="$(readlink -f "${d}/cwd" 2>/dev/null || true)"
    if [[ "${cwd}" == "${repo}" ]]; then
      return 0
    fi
  done
  return 1
}


# Release the project index when no other live session holds it. Stale
# locks from dead PIDs are pruned first so a crashed session cannot pin
# the index forever.
# Input: $1 repo path, $2 project name (may be empty).
release_when_last() {
  local repo="$1" project="$2" lockdir slug lockfile f pid
  # Resolve the real project name: fast file check, then the daemon.
  [[ -n "${project}" ]] || project="$(find_project "${repo}")"
  [[ -n "${project}" ]] || project="$(find_project_via_daemon "${repo}")"
  [[ -n "${project}" ]] || return 0
  # Locks may live under the project-name slug OR the path-derived slug
  # (ACTIVE_SLUG uses the path guess when the name was unknown at startup).
  # Remove our lock and prune dead PIDs in both candidate dirs.
  local pathslug
  pathslug="$(printf '%s' "${repo#/}" | tr '/' '-')"
  for slug in \
    "$(printf '%s' "${project}" | tr -c 'A-Za-z0-9._-' '_')" \
    "${pathslug}"; do
    lockdir="${CACHE_DIR}/.session-locks/${slug}"
    [[ -d "${lockdir}" ]] || continue
    rm -f "${lockdir}/$$" 2>/dev/null || true
    for f in "${lockdir}"/*; do
      [[ -e "${f}" ]] || continue
      pid="$(basename "${f}")"
      if [[ "${pid}" =~ ^[0-9]+$ ]] && ! kill -0 "${pid}" 2>/dev/null; then
        rm -f "${f}" 2>/dev/null || true
      fi
    done
    if [[ -n "$(ls -A "${lockdir}" 2>/dev/null)" ]]; then
      return 0   # another live session still holds this project
    fi
    rmdir "${lockdir}" 2>/dev/null || true
  done
  if other_clients_for_repo "${repo}"; then
    echo "cbm-session: other clients still attached to ${repo}, keeping index for ${project}" >&2
    return 0
  fi
  echo "cbm-session: last client for ${project} left, deleting index ..." >&2
  CBM_CACHE_DIR="${CACHE_DIR}" timeout 60 "${CBM_BIN}" cli --quiet delete_project --project "${project}" </dev/null >&2 || true
}

CACHE_RESOLVED="$(resolve_cache)"
CACHE_DIR="${CACHE_RESOLVED%%|*}"
OWNED="${CACHE_RESOLVED##*|}"
export CBM_CACHE_DIR="${CACHE_DIR}"
REPO="$(repo_path)"
PROJECT="$(find_project "${REPO}")"

child_pid=""

# Single exit path: stop the supervised MCP child, remove a temp cache
# this wrapper owns, or release the project lock (which deletes the
# index only when no other live client remains). One trap avoids the
# overwrite problem of stacked EXIT/INT/TERM traps.
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    kill -TERM "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
  fi
  if [[ "${OWNED}" == "true" ]]; then
    rm -rf "${CACHE_DIR}" 2>/dev/null || true
  else
    [[ -n "${PROJECT:-}" ]] || PROJECT="$(find_project "${REPO}")"
    [[ -n "${PROJECT:-}" ]] || PROJECT="$(find_project_via_daemon "${REPO}")"
    if [[ -n "${PROJECT:-}" ]]; then
      release_when_last "${REPO}" "${PROJECT}"
    fi
  fi
  exit "${status}"
}
trap on_exit EXIT INT TERM

# Record session lock for this project
GUESS_PROJECT="$(printf '%s' "${REPO#/}" | tr '/' '-')"
ACTIVE_SLUG="$(printf '%s' "${PROJECT:-${GUESS_PROJECT}}" | tr -c 'A-Za-z0-9._-' '_')"
if [[ "${OWNED}" != "true" && -n "${ACTIVE_SLUG}" ]]; then
  mkdir -p "${CACHE_DIR}/.session-locks/${ACTIVE_SLUG}" 2>/dev/null || true
  touch "${CACHE_DIR}/.session-locks/${ACTIVE_SLUG}/$$" 2>/dev/null || true
fi

# Supervise (not exec) so the EXIT trap above survives to release the
# project lock when the last session closes. <&0 re-attaches stdin:
# background jobs otherwise start with /dev/null as stdin. stdout stays
# reserved for MCP stdio; wrapper diagnostics already went to stderr.
"${CBM_BIN}" "$@" <&0 &
child_pid=$!

# Auto-index in background if not yet indexed so MCP initialize handshake
# is never blocked or timed out by the client.
if [[ -z "${PROJECT}" && "${REPO}" != "${HOME}" && "${REPO}" != "${HOME}/" ]]; then
  (
    echo "cbm-session: auto-indexing ${REPO} in background ..." >&2
    if CBM_CACHE_DIR="${CACHE_DIR}" timeout 300 "${CBM_BIN}" cli --quiet index_repository --repo_path "${REPO}" </dev/null >&2; then
      echo "cbm-session: auto-indexing completed for ${REPO}" >&2
    else
      echo "cbm-session: auto-indexing failed for ${REPO} (continuing)" >&2
    fi
  ) &
fi

# Reap orphaned projects in the background: prune dead-PID locks globally,
# then delete any indexed project no live session holds. Covers projects
# abandoned by SIGKILLed sessions that no new session will ever reopen.
# Skipped for owned temp caches (removed wholesale on exit anyway).
if [[ "${OWNED}" != "true" ]]; then
  (
    prune_stale_locks
    reap_orphaned_projects
  ) &
fi


wait "${child_pid}"
SESSION_WRAPPER
chmod 0755 /usr/local/bin/codebase-memory-session-mcp

# Agent CLIs whose official install is npm. Each ships per-platform binaries
# through optionalDependencies, so the global install resolves amd64/arm64
# itself: codex (@openai/codex), Claude Code (@anthropic-ai/claude-code),
# OpenCode (opencode-ai), and Cloudflare Workers tooling (wrangler).
npm install --global \
  @openai/codex \
  @anthropic-ai/claude-code \
  opencode-ai \
  wrangler@latest
npm cache clean --force

# Fail the build loudly if anything landed wrong.
for tool in omp codebase-memory-mcp codebase-memory-session-mcp rtk lazygitrs \
            lazydocker btop direnv wakatime-cli circleci codex claude opencode wrangler; do
  command -v "$tool" >/dev/null
done
