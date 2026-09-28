// devcontainer.json discovery, merge, and container lifecycle.
//
// The merge exists because the plugin needs a readiness signal and nothing
// else. `devcontainer up` returns before postCreateCommand finishes, so the
// plugin appends a marker command and polls for the file it creates.
//
// Everything else in the repo's config is left authoritative. An earlier
// version injected an sshd feature, published an SSH port, and installed a
// Herdr server inside the container, because a saved SSH machine requires all
// three. Panes now enter the container through bin/wtdc-shell instead, so the
// user's own features, remoteUser, and lifecycle commands are used as written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, STATE_DIR } from './context.mjs';
import { run, tryRun, have } from './run.mjs';
import { parseJsonc } from './jsonc.mjs';
import { detail, warn } from './ui.mjs';

/** The file whose presence means postCreateCommand finished. */
export const READY_MARKER = '/tmp/wtdc-user';

export function findConfig(worktree, candidates) {
  for (const rel of candidates.trim().split(/\s+/).filter(Boolean)) {
    const abs = path.resolve(worktree, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function mergedDirFor(src) {
  const key = path.resolve(src).replace(/[^A-Za-z0-9]/g, '_').slice(0, 60);
  return path.join(STATE_DIR, 'merged', key);
}

export function mergedPathFor(src) {
  const dir = mergedDirFor(src);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'devcontainer.json');
}

/**
 * Resolve the prebuilt image, if any.
 *
 * A prebuilt image skips the per-workspace image build the CLI would otherwise
 * derive whenever a config declares any feature. That is the difference between
 * a 4s and a 25s+ provision.
 */
export function prebuiltImage(config) {
  if (config.WTDC_IMAGE) return config.WTDC_IMAGE;
  const tpl = config.WTDC_TEMPLATE;
  if (!tpl) return '';

  const manifestFile = path.join(ROOT, 'images', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    warn(`WTDC_TEMPLATE=${tpl} but ${manifestFile} is missing`);
    return '';
  }

  const hit = (manifest.images || []).find((i) => i.name === tpl);
  if (!hit) {
    warn(`WTDC_TEMPLATE=${tpl} is not in images/manifest.json`);
    return '';
  }
  const tag = manifest.tag || 'latest';
  return `${manifest.registry}/${manifest.prefix}-${hit.name}:${tag}`;
}

/** True when the prebuilt image already ships the host's uid, so no remap is needed. */
function imageUidMatchesHost(config) {
  const ref = prebuiltImage(config);
  if (!ref) return false;
  const res = tryRun('docker', [
    'image', 'inspect', ref,
    '--format', '{{index .Config.Labels "devcontainer.remote.uid"}}',
  ]);
  const label = (res.stdout || '').trim();
  return label !== '' && label === String(os.userInfo().uid);
}

/**
 * Bind-mount the main repository's `.git` into the container.
 *
 * A linked worktree stores its git metadata as a `.git` FILE pointing at
 * `<main-repo>/.git/worktrees/<name>`, which lives outside the worktree. The
 * Dev Container CLI mounts only the workspace folder, so inside the container
 * that pointer dangles and every git command fails. Bind-mounting the common
 * directory at the identical host path is what makes it resolve; the path has
 * to match verbatim because the pointer inside the .git file holds the host's
 * absolute path.
 *
 * A main checkout is its own common directory and is already mounted as the
 * workspace, so it needs nothing.
 */
export function gitDirMount(worktree) {
  const res = tryRun('git', [
    '-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]);
  const common = (res.stdout || '').trim();
  if (!common || !fs.existsSync(common)) return null;
  if (common === worktree || common.startsWith(`${worktree}/`)) return null;
  return `type=bind,source=${common},target=${common}`;
}

/** The path the container sees the checkout at, e.g. /workspaces/feat. */
export function containerWorkspace(worktree) {
  const cid = containerFor(worktree);
  if (!cid) return '';
  const res = tryRun('docker', [
    'inspect', '-f', '{{ index .Config.Labels "devcontainer.local_workspace_folder" }}', cid,
  ]);
  return (res.stdout || '').trim();
}

export function containerFor(worktree) {
  const res = tryRun('docker', ['ps', '-aq', '--filter', `label=devcontainer.local_folder=${worktree}`]);
  return (res.stdout || '').trim().split('\n').filter(Boolean)[0] || '';
}

export function containerIsRunning(containerId) {
  if (!containerId) return false;
  const res = tryRun('docker', ['ps', '-q', '--filter', `id=${containerId}`]);
  return (res.stdout || '').trim() !== '';
}

/** True once postCreateCommand has written the readiness marker. */
export function postCreateDone(containerId) {
  const res = tryRun('docker', ['exec', containerId, 'sh', '-lc', `[ -f ${READY_MARKER} ]`]);
  return res.status === 0;
}

function asCommandString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // The CLI joins array items with a space and execs the result as one line,
    // so an array is not a safe way to append work. Chain them instead.
    return value.map((v) => String(v)).join(' && ');
  }
  if (typeof value === 'object') {
    throw new Error('object-form postCreateCommand cannot be merged safely');
  }
  return String(value);
}

/**
 * Rewrite the repo's config into a temporary copy the CLI will accept.
 *
 * The copy lives outside the worktree, so the checkout stays pristine and
 * `git status` shows nothing after provisioning.
 */
export function buildMerged(src, out, config) {
  const plain = parseJsonc(fs.readFileSync(src, 'utf8'));
  const prebuilt = prebuiltImage(config);

  if (prebuilt) {
    const dropped = Object.keys(plain.features || {});
    if (dropped.length) {
      // Dropping declared features changes what the container contains, so
      // never do it quietly.
      warn(`using prebuilt image ${prebuilt}, so these features are not applied: ${dropped.join(', ')}`);
      detail('pick a template that already includes them, or unset WTDC_IMAGE/WTDC_TEMPLATE to keep them');
    }
    plain.image = prebuilt;
    plain.features = {};
    if (config.WTDC_IMAGE_REMOTE_USER) plain.remoteUser = config.WTDC_IMAGE_REMOTE_USER;
    if (imageUidMatchesHost(config)) plain.updateRemoteUserUID = false;
  }

  const commands = [asCommandString(plain.postCreateCommand), `id -un > ${READY_MARKER}`]
    .filter((c) => c !== '');
  plain.postCreateCommand = commands.join(' && ');

  fs.writeFileSync(out, `${JSON.stringify(plain, null, 2)}\n`);
  return { droppedFeatures: prebuilt ? Object.keys(JSON.parse(fs.readFileSync(src, 'utf8').replace(/\/\/.*$/gm, '')) || {}) : [] };
}

/**
 * Build and start the container.
 *
 * Returns the container id and the container-side workspace path. Readiness is
 * the marker file rather than the CLI's exit, because `up` returns before
 * postCreateCommand has finished.
 */
export function up(worktree, merged, config) {
  const args = ['up', '--workspace-folder', worktree, '--config', merged, '--remove-existing-container'];
  if (config.WTDC_EXTRA_MOUNTS) args.push('--mount', config.WTDC_EXTRA_MOUNTS);

  const share = herdrShareMount();
  if (share) args.push('--mount', share);

  // Not an optimisation: without this, git is unusable in a linked worktree.
  const gitMount = gitDirMount(worktree);
  if (gitMount) args.push('--mount', gitMount);

  const started = Date.now();
  const deadline = started + Number(config.WTDC_BUILD_TIMEOUT || 1800) * 1000;
  const out = run('devcontainer', args);

  const payload = parseUpOutput(out);
  const containerId = payload.containerId || containerFor(worktree);

  // The marker may already be there; only wait when it is not.
  while (containerId && !postCreateDone(containerId) && Date.now() < deadline) {
    sleep(1000);
  }

  return {
    containerId,
    containerWorkspace: payload.remoteWorkspaceFolder || containerWorkspace(worktree),
    remoteUser: payload.remoteUser || '',
  };
}

/** The CLI prints a JSON summary, but not always on the last line. */
function parseUpOutput(text) {
  const candidates = text.split('\n').reverse();
  for (const line of candidates) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch { /* keep looking */ }
  }
  return {};
}

const sleep = (ms) => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
};

/**
 * Reuse the host's herdr binary instead of downloading one per container.
 *
 * The CLI's --mount has no read-only option, so mounting the live binary would
 * hand the container write access to it. Mount a cache copy instead: the worst
 * a container can do is corrupt the cache, which is rebuilt on the next miss.
 */
function herdrShareMount() {
  if (process.platform !== 'linux') return null;
  if (/^(0|false|no)$/i.test(process.env.WTDC_SHARE_HERDR_BIN || 'auto')) return null;
  const hostBin = process.env.HERDR_BIN_PATH || 'herdr';
  if (!have(hostBin, ['--version'])) return null;

  const cache = path.join(STATE_DIR, 'cache', 'herdr');
  if (!isRunnable(cache)) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.copyFileSync(hostBin, cache);
    fs.chmodSync(cache, 0o755);
  }
  return `type=bind,source=${cache},target=/usr/local/bin/herdr`;
}

function isRunnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return tryRun(file, ['--version']).status === 0;
  } catch {
    return false;
  }
}

/**
 * Destroy the container.
 *
 * `devcontainer down` can refuse on a stale config or a renamed compose
 * project, and the container is what actually matters, so fall back to
 * `docker rm -f` and never report failure.
 */
export function down(worktree, merged, containerId) {
  if (merged && fs.existsSync(merged)) {
    tryRun('devcontainer', ['down', '--workspace-folder', worktree, '--config', merged, '--remove-existing-container'], { timeout: 300_000 });
  }
  if (containerId) {
    const res = tryRun('docker', ['ps', '-aq', '--filter', `id=${containerId}`]);
    if (res.stdout.trim() !== '') tryRun('docker', ['rm', '-f', containerId]);
  }
}

/**
 * Remove any container labelled with this worktree, tracked or not.
 *
 * A build that fails after `up` succeeded leaves a running container, and the
 * failure path drops the state entry so the worktree stays retryable. That
 * leaves the container with nobody tracking it, so the Docker label — not our
 * bookkeeping — is the authority here.
 */
export function removeOrphans(worktree) {
  const res = tryRun('docker', ['ps', '-aq', '--filter', `label=devcontainer.local_folder=${worktree}`]);
  let removed = 0;
  for (const c of (res.stdout || '').split('\n').filter(Boolean)) {
    if (tryRun('docker', ['rm', '-f', c]).status === 0) removed += 1;
  }
  return removed;
}

export { run as runTool };
