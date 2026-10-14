#!/usr/bin/env bash
# One entrypoint, two Docker modes, selected by the mounts the container gets:
#
# - /var/run/docker-host.sock present (the image's devcontainer.metadata mounts
#   the host socket there) → docker-outside-of-docker: `docker` talks to the
#   host daemon. This replicates the install.sh branch of
#   ghcr.io/devcontainers/features/docker-outside-of-docker, baked in so a
#   devcontainer.json needs no feature build to get it.
# - absent → Docker-in-Docker: start dockerd as before. Plain
#   `docker run --privileged` keeps working; the Dev Container CLI no longer
#   reaches this branch because the metadata mount makes the socket visible.
set -euo pipefail

SOURCE_SOCKET=/var/run/docker-host.sock
TARGET_SOCKET=/var/run/docker.sock
SOCAT_PATH_BASE=/tmp/vscr-docker-from-docker
SOCAT_LOG=${SOCAT_PATH_BASE}.log
SOCAT_PID=${SOCAT_PATH_BASE}.pid

sudoIf() {
  if [ "$(id -u)" -ne 0 ]; then
    sudo -n "$@"
  else
    "$@"
  fi
}
log() {
  printf '[%s] %s\n' "$(date)" "$*" | sudoIf tee -a "${SOCAT_LOG}" > /dev/null
}

# Give `dev` access to the forwarded host socket, using the same fallback the
# upstream feature uses: retarget the container's docker group to the socket's
# gid when no other group owns it, and otherwise proxy the socket with socat so
# permissions can be set without changing the host's file. The symlink is also
# created in the image build; the sudo'd re-link here repairs a docker.sock
# something else replaced, which this entrypoint can run as dev.
ensure_host_socket() {
  sudoIf ln -sfn "${SOURCE_SOCKET}" "${TARGET_SOCKET}"

  local docker_gid socket_gid
  docker_gid="$(getent group docker | cut -d: -f3)"
  socket_gid="$(stat -c '%g' "${SOURCE_SOCKET}")"
  log "Ensuring dev has access to ${SOURCE_SOCKET} via ${TARGET_SOCKET}"

  if [ "${socket_gid}" != "0" ] && [ "${socket_gid}" != "${docker_gid}" ] \
    && ! getent group "${socket_gid}" > /dev/null; then
    sudoIf groupmod --gid "${socket_gid}" docker
  elif [ ! -f "${SOCAT_PID}" ] || ! ps -p "$(cat "${SOCAT_PID}")" > /dev/null; then
    log "Enabling socket proxy."
    log "Proxying ${SOURCE_SOCKET} to ${TARGET_SOCKET} for dev"
    sudoIf rm -rf "${TARGET_SOCKET}"
    sudoIf socat "UNIX-LISTEN:${TARGET_SOCKET},fork,mode=660,user=dev,backlog=128" "UNIX-CONNECT:${SOURCE_SOCKET}" \
      2>&1 | sudoIf tee -a "${SOCAT_LOG}" > /dev/null &
    echo "$!" | sudoIf tee "${SOCAT_PID}" > /dev/null
  else
    log "Socket proxy already running."
  fi
  log "Success"
}

start_daemon() {
  # Dev Containers can invoke both the image and metadata entrypoints.
  if docker --host unix:///var/run/docker.sock info > /dev/null 2>&1; then
    return
  fi

  # Docker's managed containerd keeps its PID under Docker's exec root,
  # not the system containerd directory. Old PIDs can be reused after restart.
  # A baked-in docker.sock symlink to an absent host socket is dead weight
  # here: unlink it so dockerd can bind its own socket at that path.
  rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid "${TARGET_SOCKET}"
  nohup dockerd --host=unix:///var/run/docker.sock > /var/log/dockerd.log 2>&1 &
  local daemon_pid=$!

  for ((attempt = 0; attempt < 60; attempt++)); do
    if docker --host unix:///var/run/docker.sock info > /dev/null 2>&1; then
      return
    fi
    if ! kill -0 "$daemon_pid" 2> /dev/null; then
      break
    fi
    sleep 1
  done

  echo 'Docker-in-Docker failed to start. Run this image with --privileged and separate Docker storage volumes.' >&2
  cat /var/log/dockerd.log >&2
  kill "$daemon_pid" 2> /dev/null || true
  return 1
}

if [ "${1:-}" = --start-daemon ]; then
  start_daemon
  exit
fi

if [ -e "${SOURCE_SOCKET}" ]; then
  ensure_host_socket
elif [ "$(id -u)" -eq 0 ]; then
  start_daemon
else
  # Start Docker as root, then run the container command as the workspace user.
  sudo -n "$0" --start-daemon
fi

set +e
exec "$@"
