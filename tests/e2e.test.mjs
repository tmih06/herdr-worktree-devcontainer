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

const record = (tool) => (...args) => {
  fs.appendFileSync(path.join(CALLS, tool), `${args.join(' ')}\n`);
};

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
  echo '{"result":{"worktrees":[{"path":"/workspaces/demo","open_workspace_id":"w1"}]}}'
  exit 0
fi
if [ "$a1 $a2" = "workspace list" ]; then
  echo '{"result":{"workspaces":[{"workspace_id":"w1","label":"demo"}]}}'
  exit 0
fi
# pane list backs the workspace -> pane id lookup that zoomed/split panes need.
if [ "$a1 $a2" = "pane list" ]; then
  echo '{"result":{"panes":[
    {"pane_id":"w9:p1","workspace_id":"w9","focused":true},
    {"pane_id":"w11:p1","workspace_id":"w11","focused":true}]}}'
  exit 0
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
  // no in-container herdr install.
  const merged = JSON.parse(fs.readFileSync(state().entries[WT].merged_config, 'utf8'));
  assert.deepEqual(merged.runArgs, ['--init'], 'no SSH port is published');
  assert.equal(Object.keys(merged.features || {}).length, 0, 'no feature is injected');
  assert.match(merged.postCreateCommand, /&& id -un > \/tmp\/wtdc-user$/);
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

test('boot-launch waits for the prompt overlay to close before opening', () => {
  // Opening the setup screen while the overlay is still up makes the overlay the
  // active pane, so an untargeted pane lands on the question itself.
  reset();
  wtdc(['boot-launch', WT_FRESH, 'w9', 'fresh', 'w9:p1']);

  const recorded = calls('herdr');
  assert.match(recorded, /pane list/, 'the launcher looks at the panes first');
  assert.doesNotMatch(recorded, /--workspace w9/);
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

test('the worktree checkout is left pristine', () => {
  const out = execFileSync('git', ['-C', WT, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(out.trim(), '', `worktree should be clean, got: ${out}`);
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
