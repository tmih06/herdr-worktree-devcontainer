#!/usr/bin/env node
// worktree-devcontainer — run each Herdr Git worktree's devcontainer and open a
// terminal inside it, while the worktree stays a normal Herdr worktree.
//
// Commands:
//   hook-created            event hook: offer to provision a new worktree
//   hook-removed           event hook: tear down a removed worktree
//   startup                startup hook: report tracked containers
//   provision <path> [ws] [label]
//   teardown  <path> [--force]
//   status
//   install-shell          print the terminal.default_shell line to add
//   action <id>            plugin action entry point
//
// See README.md for configuration.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, insideContainer } from './../lib/wtdc/context.mjs';
import { loadConfig } from './../lib/wtdc/config.mjs';
import { tryRun, have } from './../lib/wtdc/run.mjs';
import { step, ok, info, detail, warn, die, notify } from './../lib/wtdc/ui.mjs';
import * as state from './../lib/wtdc/state.mjs';
import * as dc from './../lib/wtdc/devcontainer.mjs';
import * as herdr from './../lib/wtdc/herdr.mjs';

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Repository name, used to keep machine/container names unique across repos. */
function projectFor(checkout) {
  const res = tryRun('git', ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gd = (res.stdout || '').trim();
  return gd ? path.basename(path.dirname(gd)) : '';
}

/** Disambiguate a slug that another worktree already claimed. */
function uniqueSlug(base, checkout) {
  const clash = state.list().some((e) => e.slug === base && e.checkout_path !== checkout);
  if (!clash) return base;
  const hash = spawnlessChecksum(checkout);
  return `${base}-${hash.slice(0, 6)}`;
}

function spawnlessChecksum(text) {
  // Only used to disambiguate a display name, so a cheap FNV-1a is enough.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function containerNameFor(slug, project) {
  const parts = [project || 'wt', slug].filter(Boolean);
  return `herdr-${parts.join('-')}`.slice(0, 63);
}

function requireHostTools() {
  for (const tool of ['docker', 'git', 'devcontainer']) {
    if (!have(tool, tool === 'docker' ? ['--version'] : ['--help'])) {
      die(`${tool} is required but was not found on PATH`);
    }
  }
}

function requireConfig(checkout, config) {
  requireHostTools();
  if (!fs.existsSync(checkout)) die(`worktree path does not exist: ${checkout}`);
  const found = dc.findConfig(checkout, config.WTDC_CONFIG_CANDIDATES);
  if (!found) die(`no devcontainer config in ${checkout} (looked for: ${config.WTDC_CONFIG_CANDIDATES})`);
  return found;
}

// ------------------------------------------------------------------ provision

function provisionFailed() {
  const checkout = process.env.WTDC_PROVISION_CHECKOUT;
  const label = process.env.WTDC_PROVISION_LABEL || 'worktree';
  if (checkout && state.has(checkout)) {
    // Drop the entry so the worktree stays retryable: hook_created skips
    // worktrees that already have state, so a half-written entry would stop the
    // prompt from ever appearing again.
    state.del(checkout);
  }
  notify(`Dev container failed: ${label}`, 'the build tab has the error; provision it again', 'request');
}

function provision(checkout, workspaceId = '', labelArg = '') {
  const config = loadConfig();
  const label = labelArg || path.basename(checkout);

  process.env.WTDC_PROVISION_LABEL = label;
  process.env.WTDC_PROVISION_CHECKOUT = checkout;
  process.on('exit', provisionFailed);

  const src = requireConfig(checkout, config);
  const slug = uniqueSlug(slugify(label), checkout);
  const project = projectFor(checkout);
  const merged = dc.mergedPathFor(src);

  step(`Preparing dev container for ${label}`);
  detail(`worktree   ${checkout}`);
  detail(`project    ${project || 'unknown'}`);
  detail(`config     ${src}`);
  detail(`merged     ${merged}`);

  const prebuilt = dc.prebuiltImage(config);
  if (!prebuilt) {
    warn('no prebuilt image configured, so this builds an image per worktree (~25s warm, minutes cold)');
    if (fs.existsSync(path.join(ROOT, 'images', 'manifest.json'))) {
      detail('for ~4s instead set WTDC_TEMPLATE in your config.env:');
      detail('  base | node | python | rust  (see images/README.md)');
    }
  } else {
    detail(`image     ${prebuilt}`);
  }

  try {
    dc.buildMerged(src, merged, config);
  } catch (err) {
    if (/object-form postCreateCommand/.test(err.message)) {
      die(`${src} uses the object form of postCreateCommand, which cannot be
   merged without changing its meaning. Convert it to a string or an array of
   strings and re-run.`);
    }
    die(`could not merge ${src} into ${merged}: ${err.message}`);
  }

  // Persist before the slow work, so a crash during the build still leaves
  // teardown able to find and clean up the merged config.
  state.set(checkout, {
    label, slug, project, checkout_path: checkout,
    container_id: '', container_name: '',
    container_workspace: '', remote_user: '',
    merged_config: merged, source_config: src,
  });

  step('Building and starting the container (this can take a while)');
  const up = dc.up(checkout, merged, config);
  if (!up.containerId) die('devcontainer up did not report a container id');

  const cname = containerNameFor(slug, project);
  if (tryRun('docker', ['rename', up.containerId, cname]).status === 0) {
    state.patch(checkout, { container_name: cname });
  } else {
    warn(`could not rename container to ${cname}`);
  }

  const remoteUser = up.remoteUser
    || (tryRun('docker', ['inspect', '-f', '{{.Config.User}}', up.containerId]).stdout || '').trim()
    || '';

  state.patch(checkout, {
    container_id: up.containerId,
    container_workspace: up.containerWorkspace,
    remote_user: remoteUser,
  });

  // The worktree stays a local Herdr worktree; the container is reached through
  // the shell dispatcher. Mark the row so the sidebar shows which worktrees are
  // containerised, without occupying a machine node.
  const icon = config.WTDC_CONTAINER_ICON || '';
  if (workspaceId && icon) {
    herdr.reportWorkspaceToken(workspaceId, 'name', `${icon} ${label}`);
  }

  info('');
  ok(`${label} is running in a dev container`);
  detail(`container: ${cname} (${up.containerId.slice(0, 12)})`);
  detail(`container cwd: ${up.containerWorkspace || '<default>'}`);

  if (config.WTDC_OPEN_CONTAINER_PANE === '1') {
    herdr.openPluginPane('container', {
      placement: 'tab',
      workspace: workspaceId || undefined,
      cwd: checkout,
      env: {
        WTDC_CONTAINER_ID: up.containerId,
        WTDC_CONTAINER_WORKSPACE: up.containerWorkspace,
        WTDC_CONTAINER_USER: remoteUser,
        WTDC_LABEL: label,
      },
      focus: true,
    });
    ok('opened the container terminal in this worktree');
  } else {
    detail('container tab opening is disabled by WTDC_OPEN_CONTAINER_PANE=0');
  }

  notify(`Dev container ready: ${label}`, 'the container terminal is attached', 'done');
  process.removeListener('exit', provisionFailed);
}

// ------------------------------------------------------------------- teardown

function teardown(checkout, force = false) {
  const config = loadConfig();
  const entry = state.get(checkout);
  if (!entry) {
    info(`no dev container tracked for ${checkout}`);
    return;
  }

  if (config.WTDC_KEEP_CONTAINER === '1' && !force) {
    warn(`WTDC_KEEP_CONTAINER=1: leaving container ${(entry.container_id || '').slice(0, 12)} running`);
  } else {
    step('Destroying the container');
    dc.down(checkout, entry.merged_config, entry.container_id);
  }

  if (entry.merged_config) {
    try {
      fs.rmSync(path.dirname(entry.merged_config), { recursive: true, force: true });
    } catch { /* already gone */ }
  }
  state.del(checkout);
  ok('torn down');
}

// --------------------------------------------------------------------- status

function status() {
  const entries = state.list();
  process.stderr.write(`\x1b[34mdev containers\x1b[0m\n`);
  if (entries.length === 0) {
    process.stderr.write('  \x1b[2mnone tracked\x1b[0m\n');
    return;
  }
  for (const e of entries) {
    const alive = dc.containerIsRunning(e.container_id) ? 'running' : 'not running';
    const label = e.label || path.basename(e.checkout_path);
    process.stderr.write(`  ${label.padEnd(30)} ${alive.padEnd(12)} ${e.checkout_path}\n`);
  }
}

// ---------------------------------------------------------------------- hooks

function hookCreated() {
  const config = loadConfig();
  if (config.WTDC_ENABLED !== '1') return;

  const checkout = herdr.eventWorktreePath();
  if (!checkout) return;
  const workspaceId = herdr.eventWorkspaceId();
  const label = herdr.eventWorktreeLabel() || path.basename(checkout);
  const repo = herdr.eventRepoName();

  if (state.has(checkout)) return;
  if (!dc.findConfig(checkout, config.WTDC_CONFIG_CANDIDATES)) {
    info(`no devcontainer config in ${checkout}; skipping`);
    return;
  }

  const env = {
    WTDC_CHECKOUT: checkout,
    WTDC_WORKSPACE: workspaceId,
    WTDC_LABEL: label,
    WTDC_REPO: repo,
  };

  if (config.WTDC_ON_CREATE === 'never') return;
  if (config.WTDC_ON_CREATE === 'auto') {
    herdr.openPluginPane('build', {
      placement: 'tab', workspace: workspaceId || undefined, cwd: checkout,
      env: { ...env, WTDC_MODE: 'provision' }, focus: true,
    });
  } else {
    herdr.openPluginPane('prompt', {
      placement: 'overlay', workspace: workspaceId || undefined, cwd: checkout, env,
    });
  }
}

function hookRemoved() {
  const config = loadConfig();
  if (config.WTDC_ENABLED !== '1') return;

  const checkout = herdr.eventWorktreePath();
  if (!checkout) return;

  if (state.has(checkout)) teardown(checkout);
  // Sweep by Docker label, so a build that failed before state was written is
  // still cleaned up.
  const removed = dc.removeOrphans(checkout);
  if (removed > 0) ok(`removed ${removed} orphaned container(s) for ${checkout}`);
}

function startup() {
  const config = loadConfig();
  if (config.WTDC_ENABLED !== '1') return;
  if (!have('docker', ['--version'])) return;

  const entries = state.list();
  const running = entries.filter((e) => dc.containerIsRunning(e.container_id)).length;
  info(`dev containers tracked: ${entries.length}, running: ${running}`);
}

// ------------------------------------------------------------------- actions

function actionInstallShell() {
  const shellPath = path.join(ROOT, 'lib', 'wtdc', 'shell.mjs');
  const stateFile = process.env.WTDC_STATE_FILE
    || path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || '', '.local', 'state'),
      'herdr', 'plugins', 'worktree-devcontainer', 'state.json');

  // This output is the deliverable, so it goes to stdout where a user or a
  // script piping the action actually sees it.
  process.stdout.write(`
To make every new terminal in a provisioned worktree open inside its
container, add this to ~/.config/herdr/config.toml:

  [terminal]
  default_shell = "${shellPath}"

Then run:  herdr server reload-config

It is a pass-through everywhere else: a pane in any other directory execs
your real $SHELL unchanged. The dispatcher reads ${stateFile}
`);
}

function actionProvision() {
  const checkout = herdr.contextWorktree();
  if (!checkout) die('this action must be invoked from a worktree workspace');
  const workspaceId = process.env.HERDR_WORKSPACE_ID || '';
  provision(checkout, workspaceId, herdr.workspaceLabel(workspaceId) || path.basename(checkout));
}

function actionTeardown() {
  const checkout = herdr.contextWorktree();
  if (!checkout) die('this action must be invoked from a worktree workspace');
  teardown(checkout);
}

// ---------------------------------------------------------------------- entry

function main() {
  // Hard anti-recursion guard, checked before anything else. The marker file is
  // the dependable signal: postCreateCommand writes it, so it only exists in a
  // container this plugin provisioned.
  if (insideContainer()) {
    process.stdout.write('worktree-devcontainer: disabled inside a dev container\n');
    return;
  }

  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'hook-created': return hookCreated();
    case 'hook-removed': return hookRemoved();
    case 'startup': return startup();
    case 'provision': {
      if (!rest[0]) die('worktree path required');
      return provision(rest[0], rest[1] || '', rest[2] || '');
    }
    case 'teardown': {
      if (!rest[0]) die('worktree path required');
      return teardown(rest[0], rest[1] === '--force' || rest[1] === '1');
    }
    case 'status': return status();
    case 'install-shell': return actionInstallShell();
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(`
worktree-devcontainer — run each Herdr worktree's devcontainer and open
terminals inside it, keeping the worktree grouped under its repo.

  hook-created            event hook: offer to provision a new worktree
  hook-removed            event hook: tear down a removed worktree
  startup                 startup hook: report tracked containers
  provision <path> [ws] [label]
  teardown  <path> [--force]
  status
  install-shell           print the terminal.default_shell line to add
  action <id>             plugin action entry point
`);
      return;
    case 'action': {
      const id = rest[0];
      if (id === 'provision') return actionProvision();
      if (id === 'teardown') return actionTeardown();
      if (id === 'status') return status();
      if (id === 'install-shell') return actionInstallShell();
      return die(`unknown action: ${id || ''}`);
    }
    default:
      return die(`unknown command: ${cmd || '(none)'} (try: help)`);
  }
}

main();
