#!/usr/bin/env bash
set -euo pipefail

start_daemon() {
  # Dev Containers can invoke both the image and metadata entrypoints.
  if docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; then
    return
  fi

  # A stopped container can leave PID files behind when it is restarted.
  rm -f /var/run/docker.pid /var/run/containerd/containerd.pid
  nohup dockerd --host=unix:///var/run/docker.sock > /var/log/dockerd.log 2>&1 &
  local daemon_pid=$!

  for ((attempt = 0; attempt < 60; attempt++)); do
    if docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; then
      return
    fi
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  echo 'Docker-in-Docker failed to start. Run this image with --privileged and separate Docker storage volumes.' >&2
  cat /var/log/dockerd.log >&2
  kill "$daemon_pid" 2>/dev/null || true
  return 1
}

if [ "${1:-}" = --start-daemon ]; then
  start_daemon
  exit
fi

if [ "$(id -u)" -eq 0 ]; then
  start_daemon
else
  # Start Docker as root, then run the container command as the workspace user.
  sudo -n "$0" --start-daemon
fi

exec "$@"
