#!/usr/bin/env bash
# Streams `devcontainer up` (or teardown) into a normal herdr tab.
#
# Everything slow runs here rather than in the event hook or the prompt
# overlay: a first image build can take many minutes, and neither of those
# should hold up the herdr UI.

set -uo pipefail

WTDC_ROOT="${HERDR_PLUGIN_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"

MODE="${WTDC_MODE:-provision}"
CHECKOUT="${WTDC_CHECKOUT:-}"
LABEL="${WTDC_LABEL:-}"

printf '\033[2J\033[H'
printf 'dev container: %s for %s\n' "$MODE" "${LABEL:-$(basename "$CHECKOUT")}"
printf '%s\n\n' "$(printf '=%.0s' {1..60})"

if [ -z "$CHECKOUT" ]; then
  printf '\nerror: no worktree path in the invocation context\n'
  exit 1
fi

"$WTDC_ROOT/bin/wtdc" "$MODE" "$CHECKOUT"
rc=$?

printf '\n%s\n' "$(printf '=%.0s' {1..60})"
if [ "$rc" -eq 0 ]; then
  printf '\033[32mdone\033[0m\n'
else
  printf '\033[31mfailed (exit %s)\033[0m\n' "$rc"
fi

# Leave the log readable. The pane closes itself when it can identify itself;
# otherwise it stays put and the user closes it like any other tab.
if [ -n "${HERDR_PANE_ID:-}" ]; then
  printf '\nclosing in 5s (ctrl-c to keep this log)\n'
  sleep 5
  "${HERDR_BIN_PATH:-herdr}" pane close "$HERDR_PANE_ID" >/dev/null 2>&1 || true
else
  printf '\npress enter to close\n'
  read -r _ || true
fi
exit "$rc"
