#!/usr/bin/env bash
# End-to-end exercise of provision + teardown against stubbed host tools.
# Proves the orchestration, state, ssh-config projection and cleanup wiring
# without needing a real image build.
#
#   bash tests/e2e.sh
set -uo pipefail

PLUGIN_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

BIN="$SANDBOX/bin"
mkdir -p "$BIN"

export HOME="$SANDBOX/home"
mkdir -p "$HOME"
# Stand in for the host's installed plugins so the share path is exercised.
mkdir -p "$HOME/.config/herdr/plugins/some-other-plugin"
export HERDR_PLUGIN_ROOT="$PLUGIN_ROOT"
export HERDR_PLUGIN_ID=worktree-devcontainer
export HERDR_PLUGIN_STATE_DIR="$SANDBOX/state"
export HERDR_PLUGIN_CONFIG_DIR="$SANDBOX/config"
export HERDR_BIN_PATH="$BIN/herdr"
export PATH="$BIN:$PATH"

REPO="$SANDBOX/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email t@t.t
git -C "$REPO" config user.name t
mkdir -p "$REPO/.devcontainer"
cat >"$REPO/.devcontainer/devcontainer.json" <<'JSON'
{
  // worktree devcontainer
  "name": "demo",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "postCreateCommand": "echo upstream-ok",
  "runArgs": ["--init"]
}
JSON
git -C "$REPO" add -A
git -C "$REPO" commit -qm init

# A real linked worktree, so `git rev-parse --git-path info/exclude` resolves
# to the shared exclude file the way it does in production.
WT="$SANDBOX/worktrees/demo"
git -C "$REPO" worktree add -q -b demo "$WT"

# ---------------------------------------------------------------- stubs

cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$WTDC_FAKE_STATE/docker_calls"
case "$1 $2" in
  "ps -aq"|"ps -q")
    if [ "${3:-}" = "--filter" ] && [[ "${4:-}" == id=* || "${4:-}" == label=devcontainer.local_folder=* ]]; then
      [ -f "$WTDC_FAKE_STATE/container" ] && cat "$WTDC_FAKE_STATE/container"
    fi
    exit 0 ;;
esac
case "$1" in
  ps)
    if [ "${3:-}" = "--filter" ] && [[ "${4:-}" == id=* ]]; then
      [ -f "$WTDC_FAKE_STATE/container" ] && cat "$WTDC_FAKE_STATE/container"
    fi
    exit 0 ;;
  port)
    [ -f "$WTDC_FAKE_STATE/container" ] || exit 1
    echo "127.0.0.1:49154"
    exit 0 ;;
  inspect)
    echo "172.18.0.9"
    exit 0 ;;
  exec)
    shift
    # Strip leading flags (-d, -u <user>, -e K=V); the first non-flag is the cid.
    detach=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -d) detach=1; shift ;;
        -u|-e) shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    if [ -n "$detach" ]; then
      echo "$*" >>"$WTDC_FAKE_STATE/execs"
      exit 0
    fi
    # $1 is the container id; the rest is the command.
    shift
    case "$*" in
      *"cat /tmp/wtdc-user"*) echo devuser ;;
      *"getent passwd"*)      echo "devuser:x:1000:1000::/home/devuser:/bin/bash" ;;
      *"id -un"*)             echo devuser ;;
      *"--version"*)          echo "herdr 0.9.1" ;;
      *"status server"*)      echo "server: running" ;;
      *)                      : ;;
    esac
    exit 0 ;;
  rename)
    shift           # docker rename <old> <new>: the new name is the second arg
    printf '%s\n' "$2" > "$WTDC_FAKE_STATE/container_name"
    echo "$2"
    exit 0 ;;
  rm)
    rm -f "$WTDC_FAKE_STATE/container"
    echo "removed"
    exit 0 ;;
esac
exit 0
STUB

cat >"$BIN/devcontainer" <<'STUB'
#!/usr/bin/env bash
sub="$1"; shift
cfg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) cfg="$2"; shift 2 ;;
    --workspace-folder|--mount) shift 2 ;;
    *) shift ;;
  esac
done
echo "devcontainer $sub starting" >&2
[ "$sub" = "up" ] || exit 0
if [ ! -f "$cfg" ]; then echo "no config at $cfg" >&2; exit 1; fi
# Either the plugin injected the sshd feature, or it is using a prebuilt image
# that already has sshd baked in. Both are valid; neither alone is a bug.
grep -q "sshd" "$cfg" || grep -q '"image"' "$cfg" || {
  echo "merged config has neither the sshd feature nor a prebuilt image" >&2; exit 1; }
echo "devcontainer up complete" >&2
printf '{"containerId":"deadbeefcafe","remoteWorkspaceFolder":"/workspaces/demo","remoteUser":"devuser"}'
STUB

cat >"$BIN/ssh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$WTDC_FAKE_STATE/ssh_calls"
exit 0
STUB

cat >"$BIN/herdr" <<'STUB'
echo "$*" >>"$WTDC_FAKE_STATE/herdr_calls"
if [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  # Mirror the real contract herdr enforces: overlay and popup panes always
  # target the active pane, so an explicit --workspace or --target-pane is
  # rejected. Without this the stub would happily accept the bug.
  case " $* " in
    *" --placement overlay "*|*" --placement popup "*)
      case " $* " in
        *" --workspace "*|*" --target-pane "*)
          echo '{"error":{"code":"invalid_params","message":"overlay and popup plugin panes target the active pane"}}'
          exit 1 ;;
      esac ;;
  esac
  exit 0
fi
if [ "$1" = "machine" ] && [ "$2" = "add" ]; then
  label=""
  while [ $# -gt 0 ]; do
    [ "$1" = "--label" ] && label="$2"
    shift
  done
  echo "$label" >"$WTDC_FAKE_STATE/machine_label"
  echo "machine added"
  exit 0
fi
if [ "$1" = "machine" ] && [ "$2" = "list" ]; then
  label=""
  [ -f "$WTDC_FAKE_STATE/machine_label" ] && label="$(cat "$WTDC_FAKE_STATE/machine_label")"
  printf '[{"id":"m1","label":"%s","target":"x","enabled":true}]\n' "$label"
  exit 0
fi
if [ "$1" = "machine" ] && [ "$2" = "remove" ]; then
  echo "removed" >"$WTDC_FAKE_STATE/machine_removed"
  exit 0
fi
# Herdr accepts `--machine <id>` in front of the subcommand, so match on the
# subcommand pair rather than a fixed position.
args=" $* "
case "$args" in
  *" workspace create "*)
    echo '{"result":{"workspace":{"workspace_id":"wr1"}}}'
    exit 0 ;;
esac
exit 0
STUB

chmod +x "$BIN"/*
export WTDC_FAKE_STATE="$SANDBOX/fake"
mkdir -p "$WTDC_FAKE_STATE"
: > "$WTDC_FAKE_STATE/docker_calls"
echo "deadbeefcafe" >"$WTDC_FAKE_STATE/container"

# ---------------------------------------------------------------- run

fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
expect() {
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m %s\n' "$1"
  else
    printf '  \033[31mFAIL\033[0m %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}
expect_contains() {
  if printf '%s' "$3" | grep -qF -- "$2"; then
    printf '  \033[32mPASS\033[0m %s\n' "$1"
  else
    printf '  \033[31mFAIL\033[0m %s (missing %q)\n       actual: %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

step "provision"
out="$("$PLUGIN_ROOT/bin/wtdc" provision "$WT" w9 demo 2>&1)"
rc=$?
printf '%s\n' "$out" | sed 's/^/  | /'
expect 'provision exits 0' 0 "$rc"
expect 'container id recorded' 'deadbeefcafe' \
  "$(jq -r '.entries["'"$WT"'"].container_id' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'ssh host recorded' '127.0.0.1' \
  "$(jq -r '.entries["'"$WT"'"].ssh_host' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'ssh port recorded' '49154' \
  "$(jq -r '.entries["'"$WT"'"].ssh_port' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'ssh user recorded' 'devuser' \
  "$(jq -r '.entries["'"$WT"'"].ssh_user' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'machine id recorded' 'm1' \
  "$(jq -r '.entries["'"$WT"'"].machine_id' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'remote workspace recorded' '/workspaces/demo' \
  "$(jq -r '.entries["'"$WT"'"].remote_workspace' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'machine label carries project and worktree' 'devc-repo-demo' "$(cat "$WTDC_FAKE_STATE/machine_label")"

step "handing the user over to the container"
calls="$(cat "$WTDC_FAKE_STATE/herdr_calls")"
expect_contains 'workspace created on the machine' '--machine m1 workspace create' "$calls"
expect 'remote workspace id recorded' 'wr1' \
  "$(jq -r '.entries["'"$WT"'"].remote_workspace_id' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect_contains 'container workspace focused' '--machine m1 workspace focus wr1' "$calls"
expect_contains 'host workspace closed' 'workspace close w9' "$calls"
expect 'focus happens before the host workspace closes' 'yes' \
  "$(printf '%s' "$calls" | awk '/workspace focus/{f=NR} /workspace close/{c=NR} END{print (f && c && f<c) ? "yes" : "no"}')"
expect_contains 'completion announced' 'notification show Dev container ready' "$calls"
expect_contains 'completion used the done sound' '--sound done' "$calls"
expect 'container renamed to project and worktree' 'herdr-devc-repo-demo' \
  "$(cat "$WTDC_FAKE_STATE/container_name" 2>/dev/null)"
expect 'project recorded in state' 'repo' \
  "$(jq -r --arg k "$WT" '.entries[$k].project' "$HERDR_PLUGIN_STATE_DIR/state.json")"

step "sharing host state and refusing to recurse"
merged_cfg="$(jq -r --arg k "$WT" '.entries[$k].merged_config' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'recursion guard set in remoteEnv' '1' "$(jq -r '.remoteEnv.WTDC_IN_CONTAINER // "no"' "$merged_cfg")"
expect_contains 'install is skipped when herdr is present' 'command -v herdr >/dev/null 2>&1 || {' "$(jq -r .postCreateCommand "$merged_cfg")"
expect_contains 'shared plugins linked into the container home' 'ln -sfn' "$(jq -r .postCreateCommand "$merged_cfg")"
expect 'refuses to act when the container env says so' 'worktree-devcontainer: disabled inside a dev container' \
  "$(WTDC_IN_CONTAINER=1 "$PLUGIN_ROOT/bin/wtdc" provision "$WT" 2>&1)"
# The dependable signal: the marker file postCreateCommand writes inside the
# container. Point it at a temp path so the test never plants the real one,
# which would silently disable the plugin on the host.
touch "$SANDBOX/marker"
expect 'refuses to act when the provision marker is present' 'worktree-devcontainer: disabled inside a dev container' \
  "$(WTDC_IN_CONTAINER_MARKER="$SANDBOX/marker" "$PLUGIN_ROOT/bin/wtdc" provision "$WT" 2>&1)"
rm -f "$SANDBOX/marker"
expect 'and that is a no-op, not a failure' '0' \
  "$(WTDC_IN_CONTAINER=1 "$PLUGIN_ROOT/bin/wtdc" provision "$WT" >/dev/null 2>&1; echo $?)"

step "merged devcontainer config on disk"
merged="$(jq -r --arg k "$WT" '.entries[$k].merged_config' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'merged file written' 'yes' "$([ -f "$merged" ] && echo yes || echo no)"
expect 'merged file is named devcontainer.json' 'devcontainer.json' "$(basename "$merged")"
expect_contains 'sshd feature present' 'features/sshd:1' "$(cat "$merged")"
expect_contains 'publish injected' '"--publish","127.0.0.1::2222"' "$(jq -c '.runArgs' "$merged")"
expect_contains 'upstream runArgs kept' '"--init"' "$(jq -c '.runArgs' "$merged")"
expect_contains 'upstream postCreate kept' 'upstream-ok' "$(jq -c '.postCreateCommand' "$merged")"
expect_contains 'herdr install injected' 'herdr.dev/install.sh' "$(jq -c '.postCreateCommand' "$merged")"
expect_contains 'pubkey injected' 'authorized_keys' "$(jq -c '.postCreateCommand' "$merged")"

step "prebuilt images skip the build entirely"
mkdir -p "$SANDBOX/prebuilt"
cp -r "$WT/.devcontainer/devcontainer.json" "$SANDBOX/prebuilt/devcontainer.json"
WT6="$SANDBOX/worktrees/prebuilt"
git -C "$REPO" worktree add -q -b prebuilt "$WT6" 2>/dev/null
cp "$SANDBOX/prebuilt/devcontainer.json" "$WT6/.devcontainer/devcontainer.json"
out="$(WTDC_IMAGE=local/wtdc-prebuilt:test "$PLUGIN_ROOT/bin/wtdc" provision "$WT6" w14 prebuilt 2>&1)"
if [ -z "$(jq -r --arg k "$WT6" '.entries[$k] // empty' "$HERDR_PLUGIN_STATE_DIR/state.json")" ]; then
  echo "  provision output:"; printf '%s\n' "$out" | sed 's/^/    | /'
fi
merged6="$(jq -r --arg k "$WT6" '.entries[$k].merged_config' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect_contains 'the prebuilt image is used verbatim' '"image": "local/wtdc-prebuilt:test"' "$(cat "$merged6")"
expect_contains 'remoteUser defaults to dev' '"remoteUser": "dev"' "$(cat "$merged6")"
expect_contains 'still publishes the ssh port' '"--publish","127.0.0.1::2222"' "$(jq -c '.runArgs' "$merged6")"
expect_contains 'authorized_keys still injected per container' 'authorized_keys' "$(jq -r .postCreateCommand "$merged6")"
expect 'no features, so no per-workspace image is built' '0' \
  "$(jq -r '.features // {} | length' "$merged6")"
# Tear it down again: later sections assert on a single tracked worktree.
"$PLUGIN_ROOT/bin/wtdc" teardown "$WT6" >/dev/null 2>&1

step "template names resolve through the manifest"
expect 'template resolves to the registry ref' 'ghcr.io/tmih06/herdr-devcontainer-rust:latest' \
  "$(env -u WTDC_IMAGE WTDC_TEMPLATE=rust bash -c 'source lib/common.sh; source lib/state.sh; source lib/devcontainer.sh; dc::prebuilt_image')"
expect 'an unknown template resolves to nothing' '' \
  "$(env -u WTDC_IMAGE WTDC_TEMPLATE=nope bash -c 'source lib/common.sh; source lib/state.sh; source lib/devcontainer.sh; dc::prebuilt_image' 2>/dev/null)"
expect 'every manifest template is unique' '' \
  "$(jq -r '[.images[].name] | if length == (unique | length) then empty else "duplicate template names" end' images/manifest.json)"
expect 'every manifest template has a Dockerfile' '' \
  "$(jq -r '.images[].dir' images/manifest.json | while read -r d; do [ -f "$d/Dockerfile" ] || echo "$d"; done)"

step "the worktree is left pristine"
expect 'nothing generated inside the worktree' 'clean' \
  "$(git -C "$WT" status --porcelain | grep -q . && echo dirty || echo clean)"

step "ssh config"
managed="$HOME/.ssh/config.d/herdr-worktree-devcontainer"
expect 'include present' '1' "$(grep -cF 'Include ~/.ssh/config.d/*' "$HOME/.ssh/config")"
expect 'host block present' '1' "$(grep -c '^Host herdr-devc-repo-demo$' "$managed")"
expect 'port in ssh config' 'Port 49154' \
  "$(grep -A3 '^Host herdr-devc-repo-demo$' "$managed" | grep '^  Port' | sed 's/^ *//')"
expect 'identity file wired' '1' "$(grep -c 'IdentityFile' "$managed")"
expect 'known hosts isolated' '1' "$(grep -c 'UserKnownHostsFile' "$managed")"
expect 'ssh actually dialled' '1' \
  "$([ -s "$WTDC_FAKE_STATE/ssh_calls" ] && echo 1 || echo 0)"
expect_contains 'ssh used the managed alias' 'herdr-devc-repo-demo' "$(cat "$WTDC_FAKE_STATE/ssh_calls")"

step "remote workspace opened"
expect_contains 'workspace create forwarded to the machine' '--machine m1 workspace create' \
  "$(cat "$WTDC_FAKE_STATE/herdr_calls")"

step "idempotence"
out2="$("$PLUGIN_ROOT/bin/wtdc" provision "$WT" w9 demo 2>&1)"
expect 'second provision is refused by the hook, not re-run here' '1' \
  "$([ "$(jq -r '.entries | length' "$HERDR_PLUGIN_STATE_DIR/state.json")" = 1 ] && echo 1 || echo 0)"

step "status"
status_out="$("$PLUGIN_ROOT/bin/wtdc" status 2>&1)"
expect_contains 'status lists the machine' 'devc-repo-demo' "$status_out"
expect_contains 'status reports running' 'running' "$status_out"

step "teardown"
out3="$("$PLUGIN_ROOT/bin/wtdc" teardown "$WT" 2>&1)"
rc3=$?
printf '%s\n' "$out3" | sed 's/^/  | /'
expect 'teardown exits 0' 0 "$rc3"
expect 'state entry removed' '0' "$(jq -r '.entries | length' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'ssh host block removed' '0' "$(grep -c '^Host ' "$managed" || true)"
expect 'machine profile removed' 'removed' "$(cat "$WTDC_FAKE_STATE/machine_removed")"
expect 'container removed' 'no' "$([ -f "$WTDC_FAKE_STATE/container" ] && echo yes || echo no)"
expect 'merged config deleted' 'no' "$([ -f "$merged" ] && echo yes || echo no)"
expect 'merged config dir deleted' 'no' "$([ -d "$(dirname "$merged")" ] && echo yes || echo no)"

step "teardown is a no-op for unknown worktrees"
"$PLUGIN_ROOT/bin/wtdc" teardown "$SANDBOX/never-existed" >/dev/null 2>&1
expect 'unknown worktree teardown exits 0' 0 "$?"

# ---------------------------------------------------------------- hooks

reset_herdr_calls() { : >"$WTDC_FAKE_STATE/herdr_calls"; }

event_for() {
  jq -n --arg ws "$1" --arg wt "$2" --arg label "$3" --arg repo "$4" '{
    event: "worktree.created",
    data: {
      workspace: {
        workspace_id: $ws,
        label: $label,
        worktree: { repo_root: $repo, repo_name: "repo", checkout_path: $wt, is_linked_worktree: true }
      },
      worktree: { path: $wt, label: $label, is_linked_worktree: true }
    }
  }'
}

WT2="$SANDBOX/worktrees/second"
git -C "$REPO" worktree add -q -b second "$WT2"
WT3="$SANDBOX/worktrees/noconfig"
git -C "$REPO" worktree add -q -b noconfig "$WT3"
rm -f "$WT3/.devcontainer/devcontainer.json"

step "worktree.created opens the prompt overlay"
reset_herdr_calls
hook_out="$(HERDR_PLUGIN_EVENT_JSON="$(event_for w10 "$WT2" second "$REPO")" \
  "$PLUGIN_ROOT/bin/wtdc" hook-created 2>&1)"
calls="$(cat "$WTDC_FAKE_STATE/herdr_calls")"
expect 'hook reports no failure' '' "$hook_out"
expect_contains 'prompt pane requested' 'plugin pane open --plugin worktree-devcontainer --entrypoint prompt' "$calls"
expect_contains 'prompt uses the overlay placement' '--placement overlay' "$calls"
expect_contains 'prompt carries the checkout path' "WTDC_CHECKOUT=$WT2" "$calls"
expect_contains 'prompt carries the worktree label' 'WTDC_LABEL=second' "$calls"
expect_contains 'prompt still receives the workspace id as env' 'WTDC_WORKSPACE=w10' "$calls"
# herdr rejects --workspace for an overlay pane: it always targets the active
# pane. The stub enforces that contract, so a regression fails this run.
expect 'prompt does not target a workspace directly' '0' \
  "$(printf '%s' "$calls" | grep -c -- '--placement overlay.*--workspace' || true)"

step "worktree.created stays quiet without a devcontainer config"
reset_herdr_calls
HERDR_PLUGIN_EVENT_JSON="$(event_for w11 "$WT3" noconfig "$REPO")" \
  "$PLUGIN_ROOT/bin/wtdc" hook-created
expect 'no pane opened' '0' "$(grep -c 'pane open' "$WTDC_FAKE_STATE/herdr_calls" || true)"

step "worktree.created is idempotent"
reset_herdr_calls
jq -n --arg k "$WT2" '{version:1,entries:{($k):{label:"second",machine_label:"devc-repo-second"}}}' \
  >"$HERDR_PLUGIN_STATE_DIR/state.json"
HERDR_PLUGIN_EVENT_JSON="$(event_for w10 "$WT2" second "$REPO")" \
  "$PLUGIN_ROOT/bin/wtdc" hook-created
expect 'already-provisioned worktree is not re-prompted' '0' \
  "$(grep -c 'pane open' "$WTDC_FAKE_STATE/herdr_calls" || true)"

step "a failed provisioning stays retryable"
WT5="$SANDBOX/worktrees/retry"
git -C "$REPO" worktree add -q -b retry "$WT5" 2>/dev/null
rm -f "$WT5/.devcontainer/devcontainer.json"
rm -f "$WTDC_FAKE_STATE/container"
"$PLUGIN_ROOT/bin/wtdc" provision "$WT5" w13 retry >/dev/null 2>&1
expect 'provisioning failed' '1' "$?"
expect 'no state entry left behind' 'no' \
  "$(jq -r --arg k "$WT5" '.entries[$k] // "no"' "$HERDR_PLUGIN_STATE_DIR/state.json")"
reset_herdr_calls
cp "$WT/.devcontainer/devcontainer.json" "$WT5/.devcontainer/devcontainer.json"
HERDR_PLUGIN_EVENT_JSON="$(event_for w13 "$WT5" retry "$REPO")" \
  "$PLUGIN_ROOT/bin/wtdc" hook-created
expect_contains 'the prompt is offered again after a failure' '--entrypoint prompt' \
  "$(cat "$WTDC_FAKE_STATE/herdr_calls")"
rm -f "$WT5/.devcontainer/devcontainer.json"
step "WTDC_ON_CREATE=auto skips the question"
reset_herdr_calls
git -C "$REPO" worktree add -q -b third "$SANDBOX/worktrees/third" 2>/dev/null
WT4="$SANDBOX/worktrees/third"
HERDR_PLUGIN_EVENT_JSON="$(event_for w12 "$WT4" third "$REPO")" \
WTDC_ON_CREATE=auto "$PLUGIN_ROOT/bin/wtdc" hook-created
expect_contains 'build pane requested instead' '--entrypoint build' \
  "$(cat "$WTDC_FAKE_STATE/herdr_calls")"
expect 'no prompt pane' '0' "$(grep -c -- '--entrypoint prompt' "$WTDC_FAKE_STATE/herdr_calls" || true)"

step "worktree.removed tears down a tracked worktree"
reset_herdr_calls
echo deadbeefcafe >"$WTDC_FAKE_STATE/container"
"$PLUGIN_ROOT/bin/wtdc" provision "$WT4" w12 third >/dev/null 2>&1
expect 'provisioned' 'yes' \
  "$([ "$(jq -r --arg k "$WT4" '.entries[$k].machine_id // "no"' "$HERDR_PLUGIN_STATE_DIR/state.json")" = m1 ] && echo yes || echo no)"
rm_event="$(jq -n --arg ws w12 --arg wt "$WT4" '{
  event: "worktree.removed",
  data: { workspace_id: $ws, worktree: { path: $wt, label: "third" }, forced: false }
}')"
HERDR_PLUGIN_EVENT_JSON="$rm_event" "$PLUGIN_ROOT/bin/wtdc" hook-removed
expect 'removed worktree dropped from state' 'no' \
  "$(jq -r --arg k "$WT4" '.entries[$k] // "no"' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'unrelated worktree left alone' 'devc-repo-second' \
  "$(jq -r --arg k "$WT2" '.entries[$k].machine_label' "$HERDR_PLUGIN_STATE_DIR/state.json")"
expect 'container destroyed by the removal hook' 'no' \
  "$([ -f "$WTDC_FAKE_STATE/container" ] && echo yes || echo no)"

step "worktree.removed ignores untracked worktrees"
reset_herdr_calls
rm_event2="$(jq -n --arg wt "$SANDBOX/worktrees/ghost" '{
  event: "worktree.removed",
  data: { workspace_id: "w99", worktree: { path: $wt, label: "ghost" }, forced: false }
}')"
HERDR_PLUGIN_EVENT_JSON="$rm_event2" "$PLUGIN_ROOT/bin/wtdc" hook-removed
expect 'no machine removal attempted' '0' \
  "$(grep -c 'machine remove' "$WTDC_FAKE_STATE/herdr_calls" || true)"

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall e2e checks passed\033[0m\n'
else
  printf '\033[31m%d e2e check(s) failed\033[0m\n' "$fail"
fi
exit "$fail"
