// End-to-end tests against stub binaries.
//
// No real docker, devcontainer CLI, or Herdr server is involved. Each stub
// records what it was asked to do, so the assertions are about the exact
// commands the plugin issues — which is where the regressions live: a mount
// that stops being passed, a workspace that stops being marked, a teardown that
// stops sweeping orphans.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { buildMerged } from '../lib/wtdc/devcontainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'wtdc.mjs');

// ------------------------------------------------------------------ sandbox

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdc-e2e-'));
const REPO = path.join(sandbox, 'repo');
const BIN_DIR = path.join(sandbox, 'bin');
const STATE_DIR = path.join(sandbox, 'state');
const CONFIG_DIR = path.join(sandbox, 'config');
const CALLS = path.join(sandbox, 'calls');

const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, stdio: 'ignore' });

fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 't@t.t']);
git(['config', 'user.name', 't']);
fs.mkdirSync(path.join(REPO, '.devcontainer'));
fs.writeFileSync(path.join(REPO, '.devcontainer', 'devcontainer.json'), `{
  // the fixture the plugin runs against
  "name": "demo",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "postCreateCommand": "echo upstream-ok",
  "runArgs": ["--init"]
}`);
git(['add', '-A']);
git(['commit', '-qm', 'init']);

const WT = path.join(sandbox, 'worktrees', 'demo');
fs.mkdirSync(path.dirname(WT), { recursive: true });
git(['worktree', 'add', '-q', '-b', 'demo', WT]);

// Fixtures for the failure paths, created up front so later tests can refer to
// them. Neither is a real git worktree: hook_created only needs a directory
// holding a devcontainer.json.
const WT_OBJFORM = path.join(sandbox, 'worktrees', 'objform');
fs.mkdirSync(path.join(WT_OBJFORM, '.devcontainer'), { recursive: true });
fs.writeFileSync(path.join(WT_OBJFORM, '.devcontainer', 'devcontainer.json'),
  '{ "postCreateCommand": { "server": "make dev" } }');

const WT_BROKEN = path.join(sandbox, 'worktrees', 'broken');
fs.mkdirSync(path.join(WT_BROKEN, '.devcontainer'), { recursive: true });
fs.writeFileSync(path.join(WT_BROKEN, '.devcontainer', 'devcontainer.json'),
  '{ "image": "debian:12", "postCreateCommand": {"x":"y"} }');

// A valid, never-provisioned worktree, for the paths that must be reached
// before any state exists. WT itself is provisioned by an earlier test, and
// hook_created short-circuits on state, so it cannot be reused here.
const WT_FRESH = path.join(sandbox, 'worktrees', 'fresh');
fs.mkdirSync(path.join(WT_FRESH, '.devcontainer'), { recursive: true });
fs.writeFileSync(path.join(WT_FRESH, '.devcontainer', 'devcontainer.json'),
  '{ "image": "debian:12", "postCreateCommand": "echo ok" }');

// Declares a feature, so provisioning it with a template exercises the "these features
// are not applied" warning. Separate from WT_FRESH for the same reason: provisioning
// records state, and hook_created skips anything that already has it.
const WT_TEMPLATE = path.join(sandbox, 'worktrees', 'template');
fs.mkdirSync(path.join(WT_TEMPLATE, '.devcontainer'), { recursive: true });
fs.writeFileSync(path.join(WT_TEMPLATE, '.devcontainer', 'devcontainer.json'),
  '{ "image": "debian:12", "features": { "ghcr.io/devcontainers/features/node:1": {} } }');

// ------------------------------------------------------------------- stubs

fs.writeFileSync(path.join(BIN_DIR, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "$WTDC_SANDBOX/calls/docker"
a1="$1"; a2="$2"
if [ "$a1 $a2" = "ps -q" ]; then echo "deadbeefcafe"; exit 0; fi
if [ "$a1 $a2" = "ps -aq" ]; then echo "deadbeefcafe"; exit 0; fi
if [ "$a1" = "rename" ]; then exit 0; fi
if [ "$a1" = "inspect" ]; then echo "/workspaces/demo"; exit 0; fi
if [ "$a1 $a2" = "exec getent" ] || [ "$a1" = "exec" ] && [ "$3" = "getent" ]; then
  echo "devuser:x:1000:1000::/home/devuser:/bin/bash"; exit 0
fi
if [ "$a1" = "exec" ] && [ "$2" = "sh" ]; then exit 0; fi
exit 0
`);

fs.writeFileSync(path.join(BIN_DIR, 'devcontainer'), `#!/usr/bin/env bash
echo "$*" >> "$WTDC_SANDBOX/calls/devcontainer"
sub="$1"; shift
while [ $# -gt 0 ]; do
  case "$1" in
    --config|--mount) echo "$2" >> "$WTDC_SANDBOX/calls/mounts"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$sub" = "up" ] || exit 0
printf '{"containerId":"deadbeefcafe","remoteWorkspaceFolder":"/workspaces/demo","remoteUser":"devuser"}'
`);

fs.writeFileSync(path.join(BIN_DIR, 'herdr'), `#!/usr/bin/env bash
echo "$*" >> "$WTDC_SANDBOX/calls/herdr"
a1="$1"; a2="$2"; a3="$3"
if [ "$a1 $a2" = "workspace get" ]; then
  echo '{"result":{"workspace":{"workspace_id":"w9","label":"demo"}}}'
  exit 0
fi
if [ "$a1 $a2" = "worktree list" ]; then
  # The path has to be the fixture's real one: a worktree is identified by its checkout
  # path, so a stub answering with a made-up path looks like a worktree that is not there.
  echo '{"result":{"worktrees":[{"path":"'"$WTDC_SANDBOX"'/worktrees/demo","open_workspace_id":"w9"}]}}'
  exit 0
fi
if [ "$a1 $a2" = "workspace list" ]; then
  echo '{"result":{"workspaces":[{"workspace_id":"w1","label":"demo"}]}}'
  exit 0
fi
# pane list backs the workspace -> pane id lookup that zoomed/split panes need. A
# test can replace the topology through WTDC_STUB_PANES, to say "the pane the hook
# captured is gone by the time the setup screen opens".
if [ "$a1 $a2" = "pane list" ]; then
  if [ -n "\${WTDC_STUB_PANES:-}" ]; then echo "$WTDC_STUB_PANES"; exit 0; fi
  echo '{"result":{"panes":[
    {"pane_id":"w9:p1","workspace_id":"w9","focused":true},
    {"pane_id":"w11:p1","workspace_id":"w11","focused":true}]}}'
  exit 0
fi
# Herdr refuses to close a pane it does not have, so the stub has to as well: that
# refusal is what closePane() is written to survive.
if [ "$a1 $a2" = "pane close" ]; then
  if [ -n "\${WTDC_STUB_PANES:-}" ]; then
    case "$WTDC_STUB_PANES" in *"$a3"*) exit 0 ;; esac
    echo 'pane not found' >&2
    exit 1
  fi
  case "$a3" in
    w9:p1|w11:p1) exit 0 ;;
    *) echo 'pane not found' >&2; exit 1 ;;
  esac
fi
exit 0
`);

for (const f of fs.readdirSync(BIN_DIR)) fs.chmodSync(path.join(BIN_DIR, f), 0o755);

// ------------------------------------------------------------------ helpers

const env = {
  ...process.env,
  PATH: `${BIN_DIR}:${process.env.PATH}`,
  WTDC_SANDBOX: sandbox,
  // The plugin prefers HERDR_BIN_PATH so calls hit the running server's socket.
  // These tests must not inherit that from whatever shell they were launched
  // from, or they would drive a real Herdr session instead of the stub.
  HERDR_BIN_PATH: path.join(BIN_DIR, 'herdr'),
  HERDR_PLUGIN_ID: 'worktree-devcontainer',
  HERDR_PLUGIN_ROOT: ROOT,
  HERDR_PLUGIN_STATE_DIR: STATE_DIR,
  HERDR_PLUGIN_CONFIG_DIR: CONFIG_DIR,
};

function wtdc(args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
}

const state = () => JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8'));

// Config files for the install tests, each in its own directory so a test can hand the
// action a WTDC_CONFIG_FILE. Tracked and removed with the rest, for the same reason as
// in unit.test.mjs.
const scratch = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdc-e2e-cfg-'));
  scratch.push(dir);
  return dir;
};
const calls = (tool) => {
  try {
    return fs.readFileSync(path.join(CALLS, tool), 'utf8');
  } catch {
    return '';
  }
};
// The stubs append into this directory, so it has to exist after every reset.
const reset = () => {
  fs.rmSync(CALLS, { recursive: true, force: true });
  fs.mkdirSync(CALLS, { recursive: true });
};

reset();

// -------------------------------------------------------------------- tests

test('provision builds the container and records it for the dispatcher', () => {
  const res = wtdc(['provision', WT, 'w9', 'demo']);
  assert.equal(res.status, 0, res.stderr);

  const entry = state().entries[WT];
  assert.equal(entry.container_id, 'deadbeefcafe');
  assert.equal(entry.container_workspace, '/workspaces/demo');
  assert.equal(entry.remote_user, 'devuser');
  assert.equal(entry.checkout_path, WT);
  assert.equal(entry.label, 'demo');
  assert.ok(entry.container_name.startsWith('herdr-'), 'container should be renamed');
});

test('a linked worktree mounts its git metadata into the container', () => {
  // Without this the worktree's `.git` FILE points outside the mounted
  // workspace and every git command inside the container fails.
  const expected = `type=bind,source=${REPO}/.git,target=${REPO}/.git`;
  assert.ok(
    calls('mounts').split('\n').includes(expected),
    `expected the shared git dir mount, got:\n${calls('mounts')}`,
  );
});

test('nothing is injected into the image any more', () => {
  // The repo's own config is authoritative: no sshd feature, no published port,
  // no in-container herdr install. The one flag the plugin adds is the hostname, which
  // is what the prompt shows and is covered by its own tests.
  const merged = JSON.parse(fs.readFileSync(state().entries[WT].merged_config, 'utf8'));
  assert.deepEqual(merged.runArgs, ['--init', '--hostname', 'demo'], 'no SSH port is published');
  assert.equal(Object.keys(merged.features || {}).length, 0, 'no feature is injected');
  assert.match(merged.postCreateCommand, /&& id -un > \/tmp\/wtdc-user$/);
});

test('the repo\'s own devcontainer.json decides the image, by default', () => {
  // A default that silently replaced the declared image made that file a lie: the
  // provision log named one image and the config named another, and the only clue was a
  // warning about dropped features. So assert it where it matters — on the config the
  // provision actually built from, read out of the sandboxed run.
  //
  // This has to go through wtdc() rather than calling loadConfig() here: in this process
  // HERDR_PLUGIN_CONFIG_DIR is unset, so it would read the real user's config.env and
  // quietly assert whatever that happens to contain.
  const merged = JSON.parse(fs.readFileSync(state().entries[WT].merged_config, 'utf8'));
  assert.equal(merged.image, 'mcr.microsoft.com/devcontainers/base:ubuntu',
    'the image the fixture declares is the image that runs');
});

test('a template is applied only when one is asked for, and says what it drops', () => {
  // Its own checkout: provisioning one records state, and hook_created skips a worktree
  // that already has it, so sharing a fixture with a hook test would break that one.
  const res = wtdc(['provision', WT_TEMPLATE, 'w9', 'tpl'], { WTDC_TEMPLATE: 'base' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /these features are not applied/,
    'opting in still names what it dropped, rather than dropping it quietly');
  const merged = JSON.parse(fs.readFileSync(state().entries[WT_TEMPLATE].merged_config, 'utf8'));
  assert.match(merged.image, /^ghcr\.io\/.+-base:/, 'and the template does replace the image');
});

test('a worktree declaring no features needs no template to be on the fast path', () => {
  // The reason the template mechanism exists at all: any `features` makes the CLI derive
  // a per-workspace image, so every new worktree pays for a build. A config that names a
  // prebuilt image itself gets the same speed with nothing configured.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(src, '{ "image": "ghcr.io/tmih06/herdr-devcontainer-node:latest", "remoteUser": "dev" }');

  buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' });
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(merged.image, 'ghcr.io/tmih06/herdr-devcontainer-node:latest', 'the image is left alone');
  assert.deepEqual(merged.features || {}, {}, 'and there is nothing for the CLI to build from');
});

test('the worktree stays a local Herdr workspace and is marked, not moved', () => {
  const herdrCalls = calls('herdr');
  // The whole point: no machine is created, and nothing is closed or replaced.
  assert.doesNotMatch(herdrCalls, /machine add/, 'must not create a machine');
  assert.doesNotMatch(herdrCalls, /workspace close/, 'the worktree workspace must stay open');
  assert.match(herdrCalls, /workspace report-metadata w9/, 'the worktree row should be marked');
  assert.match(herdrCalls, /pane open --plugin worktree-devcontainer --entrypoint container/);
});

test('the container terminal is opened as a tab in the worktree workspace', () => {
  assert.match(calls('herdr'), /--entrypoint container --placement tab/);
  assert.match(calls('herdr'), /--workspace w9/);
  assert.match(calls('herdr'), /WTDC_CONTAINER_ID=deadbeefcafe/);
});

test('a second provision is idempotent', () => {
  reset();
  wtdc(['provision', WT, 'w9', 'demo']);
  const ups = calls('devcontainer').split('\n').filter((l) => l.startsWith('up'));
  assert.equal(ups.length, 1);
  assert.equal(state().entries[WT].container_id, 'deadbeefcafe');
});

test('object-form postCreateCommand is rejected with an actionable message', () => {
  const res = wtdc(['provision', WT_OBJFORM, 'w10', 'objform']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /object form of postCreateCommand/);
  assert.equal(state().entries[WT_OBJFORM], undefined, 'a failed provision must leave no state behind');
});

test('a failed provision leaves the worktree retryable', () => {
  wtdc(['provision', WT_BROKEN, 'w11', 'broken']);
  assert.equal(state().entries[WT_BROKEN], undefined, 'no half-written entry may block a retry');
});

test('an overlay pane is never given a target Herdr would reject', () => {
  // Herdr answers `overlay and popup plugin panes target the active pane` to any
  // --workspace or --cwd, and openPluginPane used to send both. The command
  // failed, nothing opened, and the hook still exited 0, so this was invisible.
  reset();
  wtdc(['hook-created'], {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      data: {
        worktree: { path: WT_FRESH, label: 'fresh' },
        workspace: { workspace_id: 'w9', worktree: { repo_name: 'repo', checkout_path: WT_FRESH } },
      },
    }),
  });

  const recorded = calls('herdr');
  assert.match(recorded, /pane open .*--entrypoint prompt --placement overlay/);
  assert.doesNotMatch(recorded, /--workspace /, 'an overlay must not be sent --workspace');
  assert.doesNotMatch(recorded, /--target-pane /, 'an overlay must not be sent --target-pane');
  // The worktree still has to reach the pane, so it travels in the environment.
  assert.match(recorded, /--env WTDC_CHECKOUT=/);
  // An overlay lands on the focused pane, so the worktree's workspace is focused
  // first. Without this the question is drawn over whatever the user was in.
  assert.match(recorded, /workspace focus w9/);
});

test('the boot screen zooms the worktree pane, not a tab of its own', () => {
  // Two failure modes this guards, both reported as "it opened in another
  // terminal":
  //   - untargeted, a zoomed pane opens as an extra tab and the worktree's own
  //     pane stays on the host shell, so the worktree never lands in the
  //     container;
  //   - targeted at the prompt overlay, the pane stacks on the question and dies
  //     with it, which reads as "I pressed yes and nothing happened".
  // The pane id is captured by the hook before the plugin opens anything, so it
  // is the worktree's shell and not one of ours.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p1']);

  const recorded = calls('herdr');
  assert.match(recorded, /pane open .*--entrypoint boot --placement zoomed/);
  assert.match(recorded, /--target-pane w9:p1/, 'the worktree pane is zoomed');
  assert.doesNotMatch(recorded, /--workspace /, '--workspace is rejected for a zoomed pane');
  assert.match(recorded, /workspace focus w9/);
  assert.match(recorded, /--env WTDC_TARGET_PANE=w9:p1/);
});

test('an image typed in the prompt reaches the pane that does the build', () => {
  // The whole point of the field is that what is typed is what gets built, and the build
  // happens in another process, in another pane, minutes later. A pane gets its environment
  // only through --env, so an override that stayed in the prompt's own process would be a
  // field that displays a choice and quietly ignores it.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p1'], { WTDC_OVERRIDE_IMAGE: 'ghcr.io/example/typed:1' });
  assert.match(calls('herdr'), /--env WTDC_OVERRIDE_IMAGE=ghcr\.io\/example\/typed:1/);
});

test('an untouched image field sends no override at all', () => {
  // The field is a placeholder showing what the config says, so the common case must
  // behave exactly as if the field were not there: the config's own image is used.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p1']);
  assert.doesNotMatch(calls('herdr'), /WTDC_OVERRIDE_IMAGE/);
});

test('boot-launch waits for the prompt overlay to close before opening', () => {
  // Opening the setup screen while the overlay is still up makes the overlay the
  // active pane, so an untargeted pane lands on the question itself.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p1']);

  const recorded = calls('herdr');
  assert.match(recorded, /pane list/, 'the launcher looks at the panes first');
  assert.doesNotMatch(recorded, /--workspace w9/);
});

test('a zoomed pane falls back to the workspace\'s own pane when the captured one is gone', () => {
  // The user can close the worktree's shell while the question is still up. Naming a
  // pane that is not there is rejected outright, and nothing is opened: the user has
  // answered "yes" and gets no build. The pane list is the authority, not the id the
  // hook remembered.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p9'], {
    WTDC_STUB_PANES: JSON.stringify({ result: { panes: [{ pane_id: 'w9:p7', workspace_id: 'w9', focused: true }] } }),
  });

  const recorded = calls('herdr');
  assert.doesNotMatch(recorded, /--target-pane w9:p9/, 'a pane that no longer exists must not be named');
  assert.match(recorded, /--target-pane w9:p7/, 'the worktree\'s remaining pane is the target');
  assert.match(recorded, /--env WTDC_TARGET_PANE=w9:p7/, 'and the screen must be told, not the stale id');
});

test('a zoomed pane with no pane left still goes to the right workspace', () => {
  // An untargeted pane resolves to the *active* pane, which is wherever the user
  // happened to be, so the workspace has to be focused first. `--workspace` would be
  // rejected for a zoomed pane.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p9'], {
    WTDC_STUB_PANES: JSON.stringify({ result: { panes: [] } }),
  });

  const recorded = calls('herdr');
  assert.match(recorded, /pane open .*--entrypoint boot --placement zoomed/);
  assert.match(recorded, /workspace focus w9/);
  assert.doesNotMatch(recorded, /--target-pane/, 'there is no pane to name');
  assert.doesNotMatch(recorded, /--workspace w9/, '--workspace is rejected for a zoomed pane');
});

test('the setup screen becomes the container terminal, so no container tab is opened', () => {
  // The worktree's first pane is a host shell — it was spawned before the container
  // existed. The setup screen takes that terminal over rather than opening a second
  // one beside it, so provisioning behind it must not open a tab as well: two
  // terminals, no way to tell which is the container.
  reset();
  const res = wtdc(['provision', WT_FRESH, 'w9', 'fresh'], { WTDC_HANDOFF: '1' });
  assert.equal(res.status, 0, res.stderr);

  assert.doesNotMatch(calls('herdr'), /--entrypoint container/, 'no second container terminal');
  assert.equal(state().entries[WT_FRESH].container_id, 'deadbeefcafe', 'the build still happened');
});

test('without a setup screen, provision opens the container terminal as a tab', () => {
  // The `provision` action runs with nothing on screen to hand over, so it still has
  // to put a container-backed terminal in front of the user itself.
  reset();
  wtdc(['provision', WT, 'w9', 'demo']);
  assert.match(calls('herdr'), /--entrypoint container --placement tab/);
  assert.match(calls('herdr'), /--env WTDC_CHECKOUT=/, 'the pane is told which worktree it is for');
});

test('hook-created offers the prompt only for a worktree with a devcontainer config', () => {
  const event = (checkout, workspace = 'w9', label = 'demo') => JSON.stringify({
    data: {
      worktree: { path: checkout, label },
      workspace: { workspace_id: workspace, worktree: { repo_name: 'repo', checkout_path: checkout } },
    },
  });

  // Already provisioned: must not prompt again.
  reset();
  wtdc(['hook-created'], { HERDR_PLUGIN_EVENT_JSON: event(WT) });
  assert.equal(calls('herdr'), '', 'an already-provisioned worktree must not be prompted again');

  // A worktree with no devcontainer config: silently ignored.
  reset();
  wtdc(['hook-created'], { HERDR_PLUGIN_EVENT_JSON: event(path.join(sandbox, 'elsewhere'), 'w12', 'x') });
  assert.equal(calls('herdr'), '', 'no config means no prompt');

  // A fresh worktree with a config: prompt.
  reset();
  wtdc(['hook-created'], { HERDR_PLUGIN_EVENT_JSON: event(WT_BROKEN, 'w11', 'broken') });
  assert.match(calls('herdr'), /--entrypoint prompt/);
});

test('WTDC_ON_CREATE=auto skips the question', () => {
  reset();
  wtdc(['hook-created'], {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      data: {
        worktree: { path: WT_BROKEN, label: 'broken' },
        workspace: { workspace_id: 'w11', worktree: { repo_name: 'repo' } },
      },
    }),
    WTDC_ON_CREATE: 'auto',
  });
  // The setup screen, not a background tab: zoomed, over the worktree's own
  // pane, which is what makes the worktree end up in the container rather than
  // beside a tab that is.
  assert.match(calls('herdr'), /--entrypoint boot --placement zoomed/);
  assert.match(calls('herdr'), /--target-pane w11:p1/);
  assert.match(calls('herdr'), /workspace focus w11/);
  assert.doesNotMatch(calls('herdr'), /--workspace w11/);
  assert.doesNotMatch(calls('herdr'), /--entrypoint prompt/);
  assert.doesNotMatch(calls('herdr'), /--entrypoint build/);
});

test('WTDC_ON_CREATE=never does nothing at all', () => {
  reset();
  wtdc(['hook-created'], {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      data: {
        worktree: { path: WT_BROKEN, label: 'broken' },
        workspace: { workspace_id: 'w11', worktree: { repo_name: 'repo' } },
      },
    }),
    WTDC_ON_CREATE: 'never',
  });
  assert.equal(calls('herdr'), '');
});

test('teardown destroys the container and clears state', () => {
  const res = wtdc(['teardown', WT]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(state().entries[WT], undefined);
  assert.match(calls('docker'), /rm -f deadbeefcafe/);
  assert.doesNotMatch(calls('docker'), /machine remove/, 'there is no machine any more');
});

test('WTDC_KEEP_CONTAINER=1 leaves the container running', () => {
  wtdc(['provision', WT, 'w9', 'demo']);
  reset();
  const res = wtdc(['teardown', WT], { WTDC_KEEP_CONTAINER: '1' });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /WTDC_KEEP_CONTAINER=1/);
  assert.doesNotMatch(calls('docker'), /rm -f/, 'the container must survive');
  assert.equal(state().entries[WT], undefined, 'state is still dropped');
});

test('worktree.removed sweeps containers even with no state entry', () => {
  // A build that failed after `up` leaves a container nobody is tracking.
  const orphan = path.join(sandbox, 'worktrees', 'orphan');
  fs.mkdirSync(orphan, { recursive: true });
  reset();
  wtdc(['hook-removed'], {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { worktree: { path: orphan } } }),
  });
  assert.match(calls('docker'), /rm -f/, 'the orphaned container must still be swept');
});

test('the recursion guard refuses to act inside a container', () => {
  const res = wtdc(['provision', WT, 'w9', 'demo'], { WTDC_IN_CONTAINER: '1' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /disabled inside a dev container/);
  assert.equal(calls('devcontainer'), '', 'nothing may be provisioned from inside a container');
});

test('install-shell prints the config line and does not edit config', () => {
  const res = wtdc(['install-shell']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /terminal/);
  assert.match(res.stdout, /default_shell/);
  assert.match(res.stdout, /shell\.mjs/);
});

test('a provisioned worktree is marked in the sidebar, and stays marked', () => {
  // The marker is a TTL-less token. With a TTL it appeared when provisioning finished and
  // quietly vanished ten minutes later, which reads as the container having been cleaned
  // up when nothing had happened — worse than not marking it, because it is a lie with a
  // short fuse rather than an absence.
  reset();
  wtdc(['provision', WT, 'w9', 'demo']);
  const marked = calls('herdr');
  assert.match(marked, /workspace report-metadata w9 .*--token name=\S+ demo/, 'the worktree row is marked');
  assert.doesNotMatch(marked, /--ttl-ms/, 'and the mark does not expire on its own');
});

test('teardown takes the marker off again', () => {
  // The mark claims there is a container. Once there is not, the row must stop claiming
  // it, or the one signal the user has is pointing at nothing.
  wtdc(['provision', WT, 'w9', 'demo']);
  reset();
  wtdc(['teardown', WT]);
  assert.match(calls('herdr'), /workspace report-metadata .*--clear-token name/);
});

test('install-shell points Herdr at the dispatcher, keeps a backup, and reloads', () => {
  // This is the only line that decides where a new pane runs. Printing it and trusting
  // the user to paste it left worktrees silently host-only, because a terminal opened
  // after a container is ready looks exactly like one opened before it.
  const dir = tmp();
  const configFile = path.join(dir, 'herdr', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const original = 'onboarding = false\n[terminal]\nshell_mode = "auto"\n\n[server]\nport = 1\n';
  fs.writeFileSync(configFile, original);

  const res = wtdc(['install-shell'], { WTDC_CONFIG_FILE: configFile });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /set terminal\.default_shell/);

  const after = fs.readFileSync(configFile, 'utf8');
  assert.match(after, new RegExp(`default_shell = "${ROOT}/lib/wtdc/shell\\.mjs"`));
  assert.match(after, /shell_mode = "auto"/, 'other settings in the same table must survive');
  assert.match(after, /port = 1/, 'other tables must survive');
  assert.equal(fs.readFileSync(`${configFile}.bak-before-wtdc`, 'utf8'), original,
    'the previous config has to be recoverable, since this is the user\'s file');

  // The reload is not decoration: the setting is read when the server spawns a pane, so
  // without it the edit is inert and the failure is silent.
  assert.match(calls('herdr'), /server reload-config/);
});

test('install-shell is safe to run again', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'config.toml');
  fs.writeFileSync(configFile, 'onboarding = false\n');
  wtdc(['install-shell'], { WTDC_CONFIG_FILE: configFile });
  const once = fs.readFileSync(configFile, 'utf8');

  const res = wtdc(['install-shell'], { WTDC_CONFIG_FILE: configFile });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /already installed/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), once, 'a second run must not rewrite anything');
});

test('install-shell refuses a config it cannot edit safely, and exits non-zero', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'config.toml');
  const original = '[terminal]\ndefault_shell = "/bin/sh"\n[terminal]\ndefault_shell = "/bin/dash"\n';
  fs.writeFileSync(configFile, original);

  const res = wtdc(['install-shell'], { WTDC_CONFIG_FILE: configFile });
  assert.notEqual(res.status, 0, 'a refused edit must not look like a successful one');
  assert.match(res.stdout, /declared 2 times/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original, 'the file is left exactly as it was');
});

test('the worktree checkout is left pristine', () => {
  const out = execFileSync('git', ['-C', WT, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(out.trim(), '', `worktree should be clean, got: ${out}`);
});

// ------------------------------------------------------------ pane bookkeeping

// Herdr removes a workspace as soon as its last pane closes, and a worktree whose
// workspace is gone is a worktree the user cannot get back to from the sidebar while the
// checkout is still on disk. These three helpers are the plugin's only knowledge of that,
// so they are driven against the stub herdr with whatever topology each case needs.
function paneHelper(expr, { panes } = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as herdr from ${JSON.stringify(path.join(ROOT, 'lib', 'wtdc', 'herdr.mjs'))};
    process.stdout.write(String(${expr}));
  `], {
    env: {
      ...env,
      ...(panes ? { WTDC_STUB_PANES: JSON.stringify({ result: { panes } }) } : {}),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

const two = [
  { pane_id: 'w1:p1', workspace_id: 'w1' },
  { pane_id: 'w1:p2', workspace_id: 'w1' },
];

test('resolveTargetPane: a captured pane that is still there is used as it was', () => {
  assert.equal(paneHelper('herdr.resolveTargetPane("w1", "w1:p2")', { panes: two }), 'w1:p2');
});

test('resolveTargetPane: a captured pane that is gone falls back to the workspace', () => {
  // Naming a pane that is not there is rejected outright, and nothing opens at all —
  // the user answers "yes" and gets no build, silently.
  assert.equal(paneHelper('herdr.resolveTargetPane("w1", "w1:p9")', { panes: two }), 'w1:p1');
  assert.equal(paneHelper('herdr.resolveTargetPane("w1")', { panes: two }), 'w1:p1');
});

test('resolveTargetPane: an empty workspace answers with nothing rather than a guess', () => {
  assert.equal(paneHelper('herdr.resolveTargetPane("w1", "w1:p9")', { panes: [] }), '');
});

test('isLastPane: only true when this pane is the last one standing', () => {
  assert.equal(paneHelper('herdr.isLastPane("w1", "w1:p1")', { panes: two }), 'false');
  assert.equal(paneHelper('herdr.isLastPane("w1", "w1:p1")', { panes: two.slice(0, 1) }), 'true');
});

test('closePane: a pane that is already gone is a false, not a crash', () => {
  // Herdr 0.9.0 is documented to give a zoomed pane its target's place, so by the time
  // this plugin tries to retire the host pane it may not exist any more. The refusal has
  // to be a false, or the whole handoff throws on the success path.
  assert.equal(paneHelper('herdr.closePane("w1:p9")'), 'false');
  assert.equal(paneHelper('herdr.closePane("")'), 'false');
});

test('closePane: a pane that is there gets closed, by id', () => {
  reset();
  assert.equal(paneHelper('herdr.closePane("w1:p1")', { panes: two }), 'true');
  assert.match(calls('herdr'), /pane close w1:p1/);
});

test.after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
});
