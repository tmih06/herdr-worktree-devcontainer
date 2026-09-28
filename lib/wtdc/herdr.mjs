// Calls back into Herdr.
//
// Plugins have no privileged API — the whole CLI is available — so this module
// is just a typed seam over the commands this plugin uses, plus the event and
// context shapes Herdr injects.

import { HERDR_BIN } from './context.mjs';
import { tryRun } from './run.mjs';
import { warn } from './ui.mjs';

/** Run a herdr command, returning trimmed stdout. Returns '' on any failure. */
export function herdr(args, opts = {}) {
  const res = tryRun(HERDR_BIN, args, opts);
  return res.status === 0 ? (res.stdout || '').trim() : '';
}

/** Run a herdr command, returning the parsed JSON body, or null. */
export function herdrJson(args, opts = {}) {
  const res = tryRun(HERDR_BIN, args, opts);
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

const dig = (obj, path) => path.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

const firstDefined = (obj, paths) => {
  for (const p of paths) {
    const value = dig(obj, p);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
};

function parseEnvJson(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The worktree checkout path from a worktree.created / worktree.removed event. */
export function eventWorktreePath() {
  const e = parseEnvJson('HERDR_PLUGIN_EVENT_JSON');
  if (!e) return '';
  return firstDefined(e, [
    ['data', 'worktree', 'path'],
    ['worktree', 'path'],
    ['data', 'workspace', 'worktree', 'checkout_path'],
    ['workspace', 'worktree', 'checkout_path'],
  ]);
}

export function eventWorkspaceId() {
  const e = parseEnvJson('HERDR_PLUGIN_EVENT_JSON');
  if (!e) return '';
  return firstDefined(e, [
    ['data', 'workspace', 'workspace_id'],
    ['workspace', 'workspace_id'],
    ['data', 'workspace_id'],
    ['workspace_id'],
  ]);
}

export function eventWorktreeLabel() {
  const e = parseEnvJson('HERDR_PLUGIN_EVENT_JSON');
  if (!e) return '';
  return firstDefined(e, [['data', 'worktree', 'label'], ['worktree', 'label']]);
}

export function eventRepoName() {
  const e = parseEnvJson('HERDR_PLUGIN_EVENT_JSON');
  if (!e) return '';
  return firstDefined(e, [
    ['data', 'workspace', 'worktree', 'repo_name'],
    ['workspace', 'worktree', 'repo_name'],
  ]);
}

/**
 * Resolve the worktree an action was invoked against.
 *
 * The context JSON is preferred because it carries the worktree directly. The
 * workspace lookup is the fallback for invocations that only supply
 * HERDR_WORKSPACE_ID.
 */
export function contextWorktree() {
  const ctx = parseEnvJson('HERDR_PLUGIN_CONTEXT_JSON');
  const fromCtx = ctx ? firstDefined(ctx, [['worktree', 'checkout_path']]) : '';
  if (fromCtx) return fromCtx;

  const ws = process.env.HERDR_WORKSPACE_ID;
  if (!ws) return '';
  const doc = herdrJson(['workspace', 'get', ws]);
  return firstDefined(doc || {}, [
    ['result', 'workspace', 'worktree', 'checkout_path'],
  ]);
}

export function workspaceLabel(workspaceId) {
  const doc = herdrJson(['workspace', 'get', workspaceId]);
  return firstDefined(doc || {}, [['result', 'workspace', 'label']]);
}

export function renameWorkspace(workspaceId, label) {
  if (!workspaceId) return false;
  return tryRun(HERDR_BIN, ['workspace', 'rename', workspaceId, label]).status === 0;
}

export function focusWorkspace(workspaceId) {
  if (!workspaceId) return false;
  return tryRun(HERDR_BIN, ['workspace', 'focus', workspaceId]).status === 0;
}

export function closeWorkspace(workspaceId, { group = false } = {}) {
  if (!workspaceId) return false;
  const args = ['workspace', 'close', workspaceId];
  if (group) args.push('--group');
  return tryRun(HERDR_BIN, args).status === 0;
}

/**
 * Publish a display-only token on a workspace.
 *
 * This is how the container marks its worktree row in the sidebar without
 * occupying a machine node. It is purely presentational; the token disappears
 * when the workspace closes or the TTL expires.
 */
export function reportWorkspaceToken(workspaceId, name, value, source = 'wtdc') {
  if (!workspaceId) return false;
  return tryRun(HERDR_BIN, [
    'workspace', 'report-metadata', workspaceId,
    '--source', source,
    '--token', `${name}=${value}`,
    '--ttl-ms', '600000',
  ]).status === 0;
}

const PLACEMENT_FLAG = { overlay: 'overlay', tab: 'tab', split: 'split', zoomed: 'zoomed' };

// Herdr accepts three different ways of saying "put this pane here", and picks
// between them by placement. Getting this wrong is silent in the worst way: the
// command is rejected, nothing opens, and the hook still exits 0.
//
//   tab           --workspace / --cwd       what you asked for, literally
//   overlay       (nothing)                 every target is rejected: "overlay
//                                           and popup plugin panes target the
//                                           active pane"
//   zoomed, split --target-pane / --cwd     `--workspace` is rejected: "target
//                                           an existing pane; use target_pane_id"
//
// `zoomed` and `split` are the trap. `--target-pane` places the new pane
// *relative to* its target, so naming the wrong pane does not fail loudly — it
// puts the pane in the wrong place, stacked on something that then closes and
// takes it down. So name no pane at all: a pane with no target resolves to the
// focused one, which cannot be the wrong pane if the right workspace is focused.
const TARGETLESS_PLACEMENTS = new Set(['overlay', 'popup']);

/** Open one of this plugin's declared panes. */
export function openPluginPane(entrypoint, { placement = 'tab', workspace, cwd, env = {}, focus = false, pane = '' } = {}) {
  const target = PLACEMENT_FLAG[placement] || placement;
  const args = [
    'plugin', 'pane', 'open',
    '--plugin', process.env.HERDR_PLUGIN_ID || 'worktree-devcontainer',
    '--entrypoint', entrypoint,
    '--placement', target,
  ];

  if (pane) {
    // Only ever a pane we identified ourselves, captured before this plugin put
    // anything on screen. See shellPaneOf.
    args.push('--target-pane', pane);
    if (workspace) focusWorkspace(workspace);
  } else if (TARGETLESS_PLACEMENTS.has(target)) {
    if (workspace) focusWorkspace(workspace);
  } else if (workspace) {
    args.push('--workspace', workspace);
  }

  // `--cwd` is accepted by every placement, so it is always safe to send: it
  // sets where the pane starts, not which pane it becomes.
  if (cwd) args.push('--cwd', cwd);

  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null && v !== '') args.push('--env', `${k}=${v}`);
  }
  if (focus) args.push('--focus');

  // herdr() discards a failed command's output, so without this a pane that
  // never opened looked exactly like one that did.
  const res = tryRun(HERDR_BIN, args);
  if (res.status !== 0) {
    warn(`could not open the ${entrypoint} pane (${target}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.status === 0;
}

/** The panes of a workspace, as { pane_id, label, focused } records. */
export function panesIn(workspaceId) {
  if (!workspaceId) return [];
  const doc = herdrJson(['pane', 'list']);
  const panes = (doc && (doc.panes || (doc.result && doc.result.panes))) || [];
  return panes
    .filter((p) => p.workspace_id === workspaceId)
    .map((p) => ({ pane_id: p.pane_id, label: p.label || '', focused: !!p.focused }));
}

/**
 * The pane a new worktree's own shell lives in.
 *
 * Read before any plugin pane is opened, because a pane opened with no target
 * resolves to the active pane and so cannot be told apart from a shell afterwards.
 * That matters: the boot screen has to zoom *this* pane. Left untargeted it
 * opened as an extra tab beside the worktree, which is the "it appeared in
 * another terminal" symptom — the worktree's own pane was never taken over.
 */
export function shellPaneOf(workspaceId) {
  const panes = panesIn(workspaceId);
  return panes.length ? panes[0].pane_id : '';
}

/** True when the plugin refuses to act because it is already in a container. */
export function notificationSupported() {
  return tryRun(HERDR_BIN, ['notification', 'show', '--help']).status === 0;
}
