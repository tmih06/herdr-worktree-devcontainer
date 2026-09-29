#!/usr/bin/env bash
# Real end-to-end test. Needs docker, the devcontainer CLI, and a running Herdr.
#
#   bash tests/real-e2e.sh
#
# The unit and stubbed tests prove the plugin issues the right commands. This
# proves the thing they cannot: that a real terminal in a real worktree really
# does land inside a real container, and that git works there. The dispatcher is
# the load-bearing piece, so it gets driven through an actual PTY.
set -uo pipefail

PLUGIN_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

SANDBOX="$(mktemp -d /tmp/wtdc-real.XXXXXX)"
export HERDR_PLUGIN_ROOT="$PLUGIN_ROOT"
export HERDR_PLUGIN_ID=worktree-devcontainer
export HERDR_PLUGIN_STATE_DIR="$SANDBOX/state"
export HERDR_PLUGIN_CONFIG_DIR="$SANDBOX/config"
export WTDC_SANDBOX="$SANDBOX"
mkdir -p "$SANDBOX"/{state,config,bin}

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m %s\n' "$1"
  else printf '  \033[31mFAIL\033[0m %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
note() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
cleanup() {
  # The workspace has to go before the worktree: leaving a worktree workspace open with
  # a pane in a container this script is about to delete is untidy in a way that is hard
  # to see afterwards.
  for ws in ${BOOT_WS:-} ${HOST_WS:-}; do
    herdr workspace close "$ws" >/dev/null 2>&1
  done
  [ -n "${CONTAINER_ID:-}" ] && docker rm -f "$CONTAINER_ID" >/dev/null 2>&1
  [ -n "${WT:-}" ] && git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

for tool in docker devcontainer git herdr node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required; skipping"; exit 0; }
done
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to drive the PTY; skipping"; exit 0; }

# --------------------------------------------------------------- fixtures

REPO="$SANDBOX/repo"
mkdir -p "$REPO/.devcontainer"
# The image here is only a fallback: the plugin runs a prebuilt template by default, and
# sets a non-root remoteUser for it. So postCreateCommand has to be something an
# unprivileged user can run — an `apt-get install` in here cannot work, and the test fails
# for a reason that has nothing to do with what it is testing. `git --version` is enough:
# the checks below are about git *working*, in a container whose workspace is a linked
# worktree, not about git being installed.
cat >"$REPO/.devcontainer/devcontainer.json" <<'JSON'
{
  // minimal fixture: the plugin must not need to inject anything here
  "name": "real",
  "image": "debian:bookworm-slim",
  "postCreateCommand": "git --version"
}
JSON
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t.t
git -C "$REPO" config user.name t
git -C "$REPO" add -A
git -C "$REPO" commit -qm init

WT="$SANDBOX/worktrees/real"
mkdir -p "$(dirname "$WT")"
git -C "$REPO" worktree add -q -b real "$WT"

# A host workspace standing in for the one Herdr opens on worktree.created.
# The whole design depends on this one being left alone.
HOST_WS="$(herdr workspace create --cwd "$WT" --label wtdc-real-host --no-focus 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.workspace.workspace_id)}catch{}})')"
[ -n "$HOST_WS" ] || { echo "could not create a host workspace; skipping"; exit 0; }

echo "==> host workspace $HOST_WS"

node "$PLUGIN_ROOT/bin/wtdc.mjs" provision "$WT" "$HOST_WS" real >"$SANDBOX/provision.log" 2>&1
rc=$?
[ "$rc" -eq 0 ] || { echo "provision failed ($rc):"; cat "$SANDBOX/provision.log"; exit "$rc"; }

# Read one field of the recorded container, by index into the entries object.
field() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.env.HERDR_PLUGIN_STATE_DIR + "/state.json", "utf8"));
    const e = Object.values(s.entries).find((x) => x.checkout_path === process.argv[1]) || {};
    process.stdout.write(String(e[process.argv[2]] ?? ""))' "$WT" "$1"
}

CONTAINER_ID="$(field container_id)"
CUSER="$(field remote_user)"
CWS="$(field container_workspace)"

# ------------------------------------------------------------------ checks

note "the worktree stayed a local Herdr workspace"
check 'the host workspace is still open' 'yes' \
  "$(herdr workspace list 2>/dev/null | grep -q "\"$HOST_WS\"" && echo yes || echo no)"
check 'no SSH machine was created' '0' \
  "$(herdr machine list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);const a=Array.isArray(m)?m:(m.machines||m.profiles||[]);console.log(a.filter(x=>/devc|real/.test(x.label||"")).length)}catch{console.log(0)}})')"
check 'the worktree is marked in the sidebar' 'yes' \
  "$(herdr workspace get "$HOST_WS" 2>/dev/null | grep -q '"name"' && echo yes || echo no)"

note "git works inside the container"
check 'the container is named after its branch' 'real' \
  "$(docker inspect -f '{{.Config.Hostname}}' "$CONTAINER_ID" 2>/dev/null)"
check 'the branch is visible in the container' 'real' \
  "$(docker exec -u "$CUSER" -w "$CWS" "$CONTAINER_ID" git rev-parse --abbrev-ref HEAD 2>/dev/null)"
check 'the checkout is clean in the container' '' \
  "$(docker exec -u "$CUSER" -w "$CWS" "$CONTAINER_ID" git status --porcelain 2>/dev/null)"
check 'a write in the container is visible on the host' 'yes' \
  "$(docker exec -u "$CUSER" -w "$CWS" "$CONTAINER_ID" sh -lc 'echo hi > .wtdc-probe' >/dev/null 2>&1;
     [ -f "$WT/.wtdc-probe" ] && echo yes || echo no)"

note "the dispatcher puts a new terminal in the container"
# Driven through a real PTY, because the dispatcher only redirects interactive
# panes and a piped stdin must fall through to the host shell.
cat >"$SANDBOX/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$WTDC_SANDBOX/dispatcher_calls"
case "$1 $2" in "ps -q") echo "$WTDC_TEST_CID" ;; esac
exit 0
STUB
chmod +x "$SANDBOX/bin/docker"

drive() { # drive <cwd> -> prints the docker args the dispatcher chose
  # stderr is deliberately not swallowed. This driver used to die on a missing
  # environment variable, and because 2>&1 sent the traceback into /dev/null every check
  # below reported "no" for a reason that had nothing to do with the dispatcher.
  ( cd "$1" && WTDC_TEST_CID="$CONTAINER_ID" python3 - <<'PY'
import os, pty, select, time
env = dict(os.environ)
env["PATH"] = os.environ["WTDC_SANDBOX"] + "/bin:" + env["PATH"]
env["WTDC_STATE_FILE"] = os.environ["HERDR_PLUGIN_STATE_DIR"] + "/state.json"
env["WTDC_REAL_SHELL"] = "/bin/true"
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", os.environ["HERDR_PLUGIN_ROOT"] + "/lib/wtdc/shell.mjs"], env)
end = time.time() + 8
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            if not os.read(fd, 65536): break
        except OSError: break
    if os.waitpid(pid, os.WNOHANG)[0]: break
PY
) >/dev/null
  tail -1 "$SANDBOX/dispatcher_calls" 2>/dev/null
}

check 'a pane in the worktree is redirected into the container' 'yes' \
  "$(drive "$WT" | grep -q -- "exec -it.*$CONTAINER_ID" && echo yes || echo no)"
check 'the container workdir is the mounted worktree' 'yes' \
  "$(drive "$WT" | grep -q -- "-w $CWS" && echo yes || echo no)"
check 'a pane in a subdirectory keeps its position' 'yes' \
  "$(mkdir -p "$WT/sub" && drive "$WT/sub" | grep -q -- "-w $CWS/sub" && echo yes || echo no)"

note "a pane outside any worktree is left alone"
OUTSIDE="$SANDBOX/elsewhere"
mkdir -p "$OUTSIDE"
: >"$SANDBOX/dispatcher_calls"
drive "$OUTSIDE" >/dev/null
check 'no docker exec outside a worktree' '' \
  "$(grep -- '-it' "$SANDBOX/dispatcher_calls" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# The setup screen, driven the way the worktree.created hook drives it.
#
# This is the part the stubbed tests cannot see: a real plugin pane, zoomed over a real
# pane, in a real workspace, doing a real build. The bug this exists to catch is that the
# worktree's own workspace used to disappear when the setup screen finished — the worktree
# was still on disk, so it looked like nothing had happened at all.
# ---------------------------------------------------------------------------

note "the setup screen leaves the worktree in one piece"

BOOT_WS="$(herdr workspace create --cwd "$WT" --label wtdc-real-boot --no-focus 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.workspace.workspace_id)}catch{}})')"
BOOT_PANE="$(herdr pane list --workspace "$BOOT_WS" 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).result.panes[0];process.stdout.write(p.pane_id)}catch{}})')"

if [ -z "$BOOT_WS" ] || [ -z "$BOOT_PANE" ]; then
  note "could not open a workspace to run the setup screen in; skipping these checks"
else
  # WTDC_STATE_FILE points the pane at this script's sandbox state, because a plugin pane
  # gets Herdr's own state directory and would otherwise record a second container here.
  BOOT_TARGET="$(herdr plugin pane open \
      --plugin worktree-devcontainer --entrypoint boot \
      --target-pane "$BOOT_PANE" --cwd "$WT" --focus \
      --env "WTDC_CHECKOUT=$WT" --env "WTDC_WORKSPACE=$BOOT_WS" --env "WTDC_LABEL=real" \
      --env "WTDC_TARGET_PANE=$BOOT_PANE" --env "WTDC_STATE_FILE=$HERDR_PLUGIN_STATE_DIR/state.json" \
      2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).result.plugin_pane.pane.pane_id)}catch{}})')"

  # A build is minutes on a cold image, so this waits rather than assuming.
  for _ in $(seq 1 300); do
    herdr pane read "$BOOT_TARGET" 2>/dev/null | grep -q 'dev container' && break
    sleep 2
  done

  check 'the worktree workspace still exists' 'yes' \
    "$(herdr workspace get "$BOOT_WS" 2>/dev/null | grep -q "\"$BOOT_WS\"" && echo yes || echo no)"
  check 'the worktree workspace still has a pane' 'yes' \
    "$(herdr pane list --workspace "$BOOT_WS" 2>/dev/null | grep -q pane_id && echo yes || echo no)"
  check 'the setup screen became the container terminal' 'yes' \
    "$(herdr pane read "$BOOT_TARGET" 2>/dev/null | grep -q 'dev container' && echo yes || echo no)"
  check 'the worktree is still on disk' 'yes' \
    "$([ -d "$WT/.git" ] || [ -f "$WT/.git" ] && echo yes || echo no)"

  # git has to work in the terminal the user is now sitting in, not just in the container.
  herdr pane run "$BOOT_TARGET" 'git rev-parse --abbrev-ref HEAD' >/dev/null 2>&1
  sleep 2
  check 'git works in the terminal the worktree left behind' 'real' \
    "$(herdr pane read "$BOOT_TARGET" 2>/dev/null | grep -oE 'real|HEAD' | tail -1)"

  # devcontainer up replaces the container, so the ids the earlier checks used are stale.
  CONTAINER_ID="$(field container_id)"

  # The prompt says `dev@<branch>:`, so the hostname has to be the branch. Read from the
  # container rather than the screen, because this is the container's own name and the
  # screen is whatever the shell last drew.
  check 'the container is named after its branch' 'real' \
    "$(docker inspect -f '{{.Config.Hostname}}' "$CONTAINER_ID" 2>/dev/null)"
fi

note "teardown"
node "$PLUGIN_ROOT/bin/wtdc.mjs" teardown "$WT" >"$SANDBOX/teardown.log" 2>&1
check 'the container is gone' 'no' \
  "$(docker ps -aq --filter "id=$CONTAINER_ID" | grep -q . && echo yes || echo no)"
check 'the state entry is gone' 'yes' \
  "$(node -e '
    const s=JSON.parse(require("fs").readFileSync(process.env.HERDR_PLUGIN_STATE_DIR+"/state.json","utf8"));
    process.stdout.write(Object.keys(s.entries).length===0?"yes":"no")')"

printf '\n'
if [ "$fail" -eq 0 ]; then printf '\033[32mall real e2e checks passed\033[0m\n'
else printf '\033[31m%d real e2e check(s) failed\033[0m\n' "$fail"; fi
exit "$fail"
