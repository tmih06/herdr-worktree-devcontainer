#!/usr/bin/env bash
# Everything that makes a container usable as a Herdr "saved machine".
#
# Herdr's machine profiles are SSH-only, so a dev container needs a real sshd,
# a real reachable port, and non-interactive key auth (background reconnects
# never answer a password prompt). This file owns all three.

if [ -n "${WTDC_REMOTE_SH_LOADED:-}" ]; then
  return 0
fi
WTDC_REMOTE_SH_LOADED=1

# shellcheck source=lib/devcontainer.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/devcontainer.sh"

SSH_CONFIG_INCLUDE_LINE='Include ~/.ssh/config.d/*'
SSH_CONFIG_DIRNAME=herdr-worktree-devcontainer
# The provisioned user and its home are already passed in via `docker exec -u`
# and `-e HOME` (see remote::container_herdr), so the shell only needs PATH.
CTR_PATH_PREFIX='export PATH="$HOME/.local/bin:$PATH";'

remote::ssh_dir() {
  printf '%s/ssh' "$(wtdc::state_dir)"
}

remote::ssh_managed_file() {
  printf '%s/config.d/%s' "$HOME/.ssh" "$SSH_CONFIG_DIRNAME"
}

# One keypair for the whole plugin, no passphrase, generated on first use.
# A passphrase is unusable here: herdr's background SSH has no agent prompt.
remote::ensure_key() {
  local dir key
  dir="$(remote::ssh_dir)"
  key="$dir/id_ed25519"
  mkdir -p "$dir"
  if [ ! -f "$key" ]; then
    ssh-keygen -t ed25519 -N '' -C 'herdr-worktree-devcontainer' -f "$key" >/dev/null
    chmod 600 "$key"
  fi
  cat "$key.pub"
}

remote::ssh_options() {
  printf '%s\n' \
    '-o BatchMode=yes' \
    '-o ConnectTimeout=5' \
    '-o IdentitiesOnly=yes'
}

# Make sure OpenSSH will read our managed drop-in. Idempotent, and never
# rewrites an existing ~/.ssh/config beyond adding the single Include line.
remote::ensure_include() {
  local cfg="$HOME/.ssh/config"
  mkdir -p "$HOME/.ssh" "$(dirname "$(remote::ssh_managed_file)")"
  chmod 700 "$HOME/.ssh" 2>/dev/null || true
  if [ ! -f "$cfg" ]; then
    printf '%s\n' "$SSH_CONFIG_INCLUDE_LINE" >"$cfg"
    chmod 600 "$cfg"
    return 0
  fi
  if ! grep -qF 'config.d' "$cfg"; then
    # Include must be near the top: OpenSSH applies the first obtained value.
    local tmp
    tmp="$(mktemp)"
    { printf '%s\n\n' "$SSH_CONFIG_INCLUDE_LINE"; cat "$cfg"; } >"$tmp"
    cat "$tmp" >"$cfg"
    rm -f "$tmp"
  fi
}

# The managed file is a pure projection of state.json, so it can never drift.
remote::rewrite_ssh_config() {
  local file
  file="$(remote::ssh_managed_file)"
  remote::ensure_include
  : >"$file.new"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    local alias host port user
    alias="$(printf '%s' "$entry" | jq -r '.ssh_alias // empty')"
    host="$(printf '%s' "$entry" | jq -r '.ssh_host // empty')"
    port="$(printf '%s' "$entry" | jq -r '.ssh_port // empty')"
    user="$(printf '%s' "$entry" | jq -r '.ssh_user // empty')"
    [ -n "$alias" ] && [ -n "$host" ] && [ -n "$port" ] && [ -n "$user" ] || continue
    {
      printf 'Host %s\n' "$alias"
      printf '  HostName %s\n' "$host"
      printf '  Port %s\n' "$port"
      printf '  User %s\n' "$user"
      printf '  IdentityFile %s\n' "$(remote::ssh_dir)/id_ed25519"
      printf '  IdentitiesOnly yes\n'
      printf '  StrictHostKeyChecking accept-new\n'
      printf '  UserKnownHostsFile %s/known_hosts\n' "$(remote::ssh_dir)"
      printf '  ServerAliveInterval 30\n'
      printf '  ServerAliveCountMax 3\n'
      printf '\n'
    } >>"$file.new"
  done < <(state::list)
  mv -f "$file.new" "$file"
  chmod 600 "$file"
}

# remote::endpoint <container_id> <container_port>
# Prints "<host>\t<port>\t<kind>". Published loopback port is preferred; the
# container's bridge IP is the fallback and only works on a Linux host.
remote::endpoint() {
  local cid="$1" port="$2" mapping ip
  mapping="$(docker port "$cid" "$port/tcp" 2>/dev/null | head -1)"
  if [ -n "$mapping" ]; then
    printf '127.0.0.1\t%s\tpublished-port' "${mapping##*:}"
    return 0
  fi
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid" 2>/dev/null | awk 'NF{print $1; exit}')"
  if [ -n "$ip" ]; then
    printf '%s\t%s\tcontainer-ip' "$ip" "$port"
    return 0
  fi
  return 1
}

# The SSH account is the devcontainer remoteUser, not the image USER. postCreateCommand
# runs as remoteUser and records who it was, so read that back rather than
# guessing from `docker exec` (which would usually answer "root").
remote::container_user() {
  local cid="$1" user
  user="$(remote::ctr_user "$cid")"
  if [ -z "$user" ]; then
    # Fall back to whichever home directory actually holds an authorized_keys.
    user="$(docker exec "$cid" sh -lc \
      'for f in /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys; do
         [ -s "$f" ] && { echo "$f" | cut -d/ -f2; break; }
       done' 2>/dev/null | tr -d '\r\n[:space:]')"
  fi
  printf '%s' "${user:-root}"
}

# Poll until the container's sshd accepts our key. Accepts the host key on
# first contact so the later non-interactive herdr connect never stalls.
# The last ssh error is kept in WTDC_SSH_LAST_ERROR so a timeout can explain
# itself instead of just reporting that it waited.
remote::wait_ssh() {
  local alias="$1" timeout_s="$2" waited=0 err
  WTDC_SSH_LAST_ERROR=""
  while [ "$waited" -lt "$timeout_s" ]; do
    err="$(ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$(remote::ssh_dir)/known_hosts" \
      "$alias" true 2>&1)" && return 0
    WTDC_SSH_LAST_ERROR="$err"
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

remote::ctr_user() {
  docker exec "$1" cat /tmp/wtdc-user 2>/dev/null | tr -d '\r\n[:space:]'
}

remote::ctr_home() {
  local cid="$1" user home
  user="$(remote::ctr_user "$cid")"
  home="$(docker exec "$cid" getent passwd "${user:-root}" 2>/dev/null | cut -d: -f6)"
  printf '%s' "${home:-/home/${user:-root}}"
}

# Run a command inside the container as the provisioned remoteUser, not as the
# image user. Starting the server as root would leave root-owned state in the
# user's home that the later SSH session cannot write, and `herdr machine add`
# fails with EACCES.
remote::container_herdr() {
  local cid="$1"; shift
  local user home
  user="$(remote::ctr_user "$cid")"
  home="$(remote::ctr_home "$cid")"
  docker exec -u "${user:-root}" -e HOME="$home" "$cid" sh -lc "$CTR_PATH_PREFIX $*"
}

remote::container_herdr_install_log() {
  docker exec "$1" sh -lc 'tail -n 20 /tmp/wtdc-install.log 2>/dev/null' 2>/dev/null
}

# A network blip while the image was being set up leaves the container without
# herdr even though postCreateCommand "succeeded" (it ends in `|| echo`). The
# container is already up at this point, so just run the same install again
# rather than telling the user to go and fix their devcontainer config.
remote::ensure_container_herdr() {
  local cid="$1" out
  if out="$(remote::container_herdr "$cid" 'herdr --version' 2>/dev/null)" && [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  wtdc::warn "herdr is missing from the container; retrying the install once"
  if [ -n "$WTDC_CONTAINER_INSTALL" ]; then
    remote::container_herdr "$cid" "$WTDC_CONTAINER_INSTALL" >/dev/null 2>&1 || true
  fi
  if out="$(remote::container_herdr "$cid" 'herdr --version' 2>/dev/null)" && [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi
  return 1
}

# Start the container-side server ourselves so that `herdr machine add` finds a
# running, compatible server and stays silent instead of prompting to install.
#
# It has to be started with setsid: herdr reports detached_server_daemon as
# getsid(0) == getpid(), so a plain `nohup ... &` leaves it in the exec's
# session and `herdr machine add` then refuses with "remote server is not
# ready for saved machines".
remote::start_container_server() {
  local cid="$1" session="${2:-}" waited=0 out cmd
  if [ -n "$session" ]; then
    cmd="herdr --session '$session' server"
  else
    cmd="herdr server"
  fi
  remote::container_herdr "$cid" \
    "if command -v setsid >/dev/null 2>&1; then
       setsid $cmd </dev/null >/tmp/herdr-server.log 2>&1 &
     else
       nohup $cmd </dev/null >/tmp/herdr-server.log 2>&1 &
     fi" >/dev/null

  while [ "$waited" -lt 60 ]; do
    out="$(remote::container_herdr "$cid" 'herdr status server' 2>/dev/null || true)"
    if printf '%s' "$out" | grep -qiE 'running|ok|active'; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# remote::add_machine <ssh_alias> <label> -> machine profile id
remote::add_machine() {
  local alias="$1" label="$2" out
  if [ -n "$WTDC_REMOTE_SESSION" ]; then
    out="$(wtdc::herdr machine add "$alias" --label "$label" --remote-session "$WTDC_REMOTE_SESSION" 2>&1)" || {
      printf '%s\n' "$out" >&2
      return 1
    }
  else
    out="$(wtdc::herdr machine add "$alias" --label "$label" 2>&1)" || {
      printf '%s\n' "$out" >&2
      return 1
    }
  fi
  remote::machine_id "$label"
}

remote::machine_id() {
  local label="$1"
  wtdc::herdr machine list --json 2>/dev/null | jq -r --arg l "$label" '
    (if type == "object" then (.machines // .profiles // []) else . end)
    | map(select(.label == $l))
    | (.[0].id // .[0].machine_id // empty)
  '
}

remote::remove_machine() {
  local id="$1"
  [ -n "$id" ] || return 0
  wtdc::herdr machine remove "$id" >/dev/null 2>&1 || true
}

remote::open_remote_workspace() {
  local machine_id="$1" cwd="$2" label="$3"
  [ "$WTDC_OPEN_REMOTE_WORKSPACE" = "1" ] || return 0
  [ -n "$machine_id" ] && [ -n "$cwd" ] || return 0
  wtdc::herdr --machine "$machine_id" workspace create \
    --cwd "$cwd" --label "$label" --no-focus >/dev/null 2>&1 || true
}
