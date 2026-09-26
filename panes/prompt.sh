#!/usr/bin/env bash
# Overlay shown right after herdr creates a worktree.
#
# Herdr plugins cannot add a widget to herdr's own worktree dialog, so this
# draws the question instead. It is launched as a transient overlay: closing
# it restores the previous focus and zoom.
#
# Keys:  y / Enter  yes        n / Esc / q  no        space  toggle the box

set -uo pipefail

WTDC_ROOT="${HERDR_PLUGIN_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/remote.sh
. "$WTDC_ROOT/lib/remote.sh"
wtdc::load_config

CHECKOUT="${WTDC_CHECKOUT:-}"
WORKSPACE="${WTDC_WORKSPACE:-}"
LABEL="${WTDC_LABEL:-}"
REPO="${WTDC_REPO:-}"

if [ -z "$CHECKOUT" ]; then
  printf 'dev container: no worktree path in the invocation context\n'
  sleep 5
  exit 1
fi

CONFIG_REL="$(dc::find_config "$CHECKOUT" | sed "s|^$CHECKOUT/||" || true)"
[ -n "$CONFIG_REL" ] || CONFIG_REL="${WTDC_C_YELLOW}none found${WTDC_C_RESET}"

restore_tty() {
  printf '\033[?25h'
  [ -n "${STTY_SAVED:-}" ] && stty "$STTY_SAVED" 2>/dev/null
  return 0
}

render() {
  local toggle="$1"
  printf '\033[2J\033[H'
  cat <<EOF
${WTDC_C_CYAN}  Dev container${WTDC_C_RESET}

  Worktree   ${LABEL}
             ${WTDC_C_DIM}${CHECKOUT}${WTDC_C_RESET}
  Config     ${CONFIG_REL}
  Repo       ${WTDC_C_DIM}${REPO:-unknown}${WTDC_C_RESET}

  Builds the image, installs herdr inside the container, and saves it as an
  SSH machine you can switch to from the sidebar. First build is slow.

  ${WTDC_C_GREEN}[${toggle}]${WTDC_C_RESET} Create a dev container for this worktree

  ${WTDC_C_DIM}y/Enter yes    n/Esc/q no    space toggle${WTDC_C_RESET}

EOF
}

# Returns 0 for yes, 1 for no.
ask() {
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    # No PTY: never block a hook on a question nobody can answer.
    printf 'dev container: no interactive terminal, skipping %s\n' "$LABEL"
    return 1
  fi

  STTY_SAVED="$(stty -g 2>/dev/null || true)"
  trap restore_tty EXIT
  stty -echo -icanon min 1 time 0 2>/dev/null || true
  printf '\033[?25l'

  local toggle=' ' ch
  toggle=' '
  while :; do
    render "$toggle"
    if ! IFS= read -rsn1 -t 600 ch; then
      render "$toggle"
      restore_tty
      return 1
    fi
    case "$ch" in
      $'\n'|$'\r') restore_tty; return 0 ;;
      y|Y)         restore_tty; return 0 ;;
      n|N|q|Q)     restore_tty; return 1 ;;
      $'\033')     restore_tty; return 1 ;;
      ' ')         [ "$toggle" = ' ' ] && toggle='x' || toggle=' ' ;;
      *)           : ;;
    esac
  done
}

if ! ask; then
  exit 0
fi

printf 'starting dev container for %s\n\n' "$LABEL"

# Hand the slow work to the build pane, opened as a tab in this same workspace
# so the user watches the image build where they just created the worktree.
args=(
  plugin pane open
  --plugin "$HERDR_PLUGIN_ID"
  --entrypoint build
  --placement tab
  --cwd "$CHECKOUT"
  --env "WTDC_MODE=provision"
  --env "WTDC_CHECKOUT=$CHECKOUT"
  --env "WTDC_LABEL=$LABEL"
  --focus
)
[ -n "$WORKSPACE" ] && args+=(--workspace "$WORKSPACE")

if ! wtdc::herdr "${args[@]}"; then
  printf 'could not open the build pane; running inline instead\n\n'
  "$WTDC_ROOT/bin/wtdc" provision "$CHECKOUT" "$WORKSPACE" "$LABEL"
fi
