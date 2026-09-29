// devcontainer.json discovery, merge, and container lifecycle.
//
// The merge exists because the plugin needs a readiness signal and nothing
// else. `devcontainer up` returns before postCreateCommand finishes, so the
// plugin appends a marker command and polls for the file it creates.
//
// Everything else in the repo's config is left authoritative. An earlier
// version injected an sshd feature, published an SSH port, and installed a
// Herdr server inside the container, because a saved SSH machine requires all
// three. Panes now enter the container through the shell dispatcher
// (lib/wtdc/shell.mjs) instead, so the user's own features, remoteUser, and
// lifecycle commands are used as written.

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

/** Longest a hostname may be, and the characters one may contain. */
const HOSTNAME_MAX = 63;

/**
 * Turn a branch name into something a container may be called.
 *
 * The point of naming a container after its branch is that the shell prompt says which
 * worktree you are in, so the name has to survive being typed and read in a prompt. A
 * hostname is a DNS label: letters, digits and hyphens, 63 characters, no leading or
 * trailing hyphen. `feat/payments` and `Fix_Thing` are not that, so they are folded.
 * Distinct branches can land on the same label, which costs nothing — hostnames need not
 * be unique, unlike container names.
 */
export function branchHostname(branch) {
  const label = String(branch || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HOSTNAME_MAX)
    .replace(/-+$/, '');
  // A label of only digits is legal but reads like an address, and an empty one is not
  // legal at all; both are better spelled out than passed to docker as-is.
  if (label === '' || /^\d+$/.test(label)) return `wt${label ? `-${label}` : ''}`;
  return label;
}

/** The branch a worktree is checked out on, or '' when it cannot be read. */
export function branchOf(worktree) {
  const res = tryRun('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (res.stdout || '').trim();
  return res.status === 0 && branch && branch !== 'HEAD' ? branch : '';
}

/**
 * The `--hostname` a container should get, or '' for none.
 *
 * `WTDC_HOSTNAME` is `branch` (the default) for the branch name, `off` for nothing, or a
 * literal hostname. An explicit `--hostname` in the repo's own runArgs always wins: the
 * repo is authoritative about its container, the same way it is about its image.
 */
export function hostnameFor(worktree, config) {
  const wanted = (config.WTDC_HOSTNAME === undefined ? 'branch' : config.WTDC_HOSTNAME).trim();
  if (wanted === '' || wanted === 'off' || wanted === '0' || wanted === 'none') return '';
  if (wanted !== 'branch') return branchHostname(wanted);
  return branchHostname(branchOf(worktree));
}

/**
 * What provisioning this worktree would do, without doing any of it.
 *
 * Shared with the prompt so the thing the user is shown and the thing that runs cannot
 * drift apart — a prompt that describes a different plan from the one executed is worse
 * than no prompt, because it is believed. Writes nothing, and no side effects beyond
 * resolving a template name.
 */
export function planProvision(src, config, worktree = '') {
  const plain = parseJsonc(fs.readFileSync(src, 'utf8'));
  const prebuilt = prebuiltImage(config);

  const declaredImage = plain.image || '';
  const declaredFeatures = Object.keys(plain.features || {});

  const merged = { ...plain };

  // An image typed into the prompt wins over everything, and unlike a template it is
  // *only* an image: features stay, because someone changing the base image still wants
  // the features applied to it. Environment only, never a config key — it is a decision
  // made once, in front of the question, not a standing preference.
  const typed = (process.env.WTDC_OVERRIDE_IMAGE || '').trim();

  if (typed) {
    merged.image = typed;
  } else if (prebuilt) {
    merged.image = prebuilt;
    merged.features = {};
    if (config.WTDC_IMAGE_REMOTE_USER) merged.remoteUser = config.WTDC_IMAGE_REMOTE_USER;
    if (imageUidMatchesHost(config)) merged.updateRemoteUserUID = false;
  }

  const commands = [asCommandString(plain.postCreateCommand), `id -un > ${READY_MARKER}`]
    .filter((c) => c !== '');
  merged.postCreateCommand = commands.join(' && ');

  let hostname = '';
  if (worktree) {
    // runArgs is the one place the CLI passes extra flags straight to `docker run`, and
    // the hostname is set at create time — changing it later means recreating the
    // container, so it has to be in the config rather than fixed up afterwards.
    const runArgs = Array.isArray(plain.runArgs) ? plain.runArgs.filter((a) => typeof a === 'string') : [];
    const alreadyNamed = runArgs.some((a) => a === '--hostname' || a === '-h' || a.startsWith('--hostname='));
    hostname = alreadyNamed ? '' : hostnameFor(worktree, config);
    if (hostname) merged.runArgs = [...runArgs, '--hostname', hostname];
  }

  // A typed image keeps the features, so it drops nothing — the same as no template at all.
  // Keyed off what actually happened rather than off `prebuilt`, or a template left in the
  // config would make the prompt report features as discarded while they are being applied.
  const dropped = !typed && prebuilt;
  const keptFeatures = Object.keys(merged.features || {});

  return {
    merged,
    image: merged.image || '',
    declaredImage,
    imageSource: typed ? 'edited in the prompt'
      : prebuilt ? (config.WTDC_IMAGE ? 'WTDC_IMAGE' : 'WTDC_TEMPLATE')
        : 'devcontainer.json',
    declaredFeatures,
    droppedFeatures: dropped ? declaredFeatures : [],
    keptFeatures,
    // The only thing that makes the CLI derive a per-workspace image. Whether a template
    // was requested says nothing about it, which is the whole reason this is measured
    // here rather than inferred from the plugin's own settings.
    buildsImage: keptFeatures.length > 0,
    remoteUser: merged.remoteUser || '',
    hostname,
    postCreateCommand: plain.postCreateCommand || '',
  };
}

/**
 * Rewrite the repo's config into a temporary copy the CLI will accept.
 *
 * The copy lives outside the worktree, so the checkout stays pristine and
 * `git status` shows nothing after provisioning.
 */
export function buildMerged(src, out, config, worktree = '') {
  const plan = planProvision(src, config, worktree);

  if (plan.droppedFeatures.length) {
    // Dropping declared features changes what the container contains, so
    // never do it quietly.
    warn(`using prebuilt image ${plan.image}, so these features are not applied: ${plan.droppedFeatures.join(', ')}`);
    detail('pick a template that already includes them, or unset WTDC_IMAGE/WTDC_TEMPLATE to keep them');
  }
  if (plan.hostname) detail(`container hostname  ${plan.hostname}`);

  fs.writeFileSync(out, `${JSON.stringify(plan.merged, null, 2)}\n`);
  return plan;
}

/**
 * Build and start the container.
 *
 * Returns the container id and the container-side workspace path. Readiness is
 * the marker file rather than the CLI's exit, because `up` returns before
 * postCreateCommand has finished.
 */
export function up(worktree, merged, config, onCreated) {
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

  // The container exists but postCreateCommand is still running, which is the
  // one boundary worth reporting: it is where a slow install happens.
  if (typeof onCreated === 'function') onCreated(containerId);

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
