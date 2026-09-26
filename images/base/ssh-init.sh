#!/bin/sh
# Start sshd, then hand over to the container command.
#
# sshd runs in the background rather than as PID 1 so the container keeps
# living normally; the plugin connects over SSH while an ordinary shell session
# runs as PID 1's child.
#
# Host keys were generated at build time, so there is no first-boot delay here.

set -e

mkdir -p /var/run/sshd
/usr/sbin/sshd -D -e &
sshd_pid=$!

term() {
    kill "$sshd_pid" 2>/dev/null || true
    wait "$sshd_pid" 2>/dev/null || true
}
trap term TERM INT

# exec so the container command becomes PID 1's direct child and signals reach
# it; sshd is deliberately kept out of the signal path.
if [ "$#" -eq 0 ]; then
    exec sleep infinity
fi
exec "$@"
