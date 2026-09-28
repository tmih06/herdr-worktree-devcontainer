// Calls back into Herdr.
//
// Plugins have no privileged API — the whole CLI is available — so this module
// is just a typed seam over the commands this plugin uses, plus the event and
// context shapes Herdr injects.

import { HERDR_BIN } from './context.mjs';
import { tryRun } from './run.mjs';

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

/** Open one of this plugin's declared panes. */
export function openPluginPane(entrypoint, { placement = 'tab', workspace, cwd, env = {}, focus = false } = {}) {
  const args = [
    'plugin', 'pane', 'open',
    '--plugin', process.env.HERDR_PLUGIN_ID || 'worktree-devcontainer',
    '--entrypoint', entrypoint,
    '--placement', PLACEMENT_FLAG[placement] || placement,
  ];
  if (workspace) args.push('--workspace', workspace);
  if (cwd) args.push('--cwd', cwd);
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null && v !== '') args.push('--env', `${k}=${v}`);
  }
  if (focus) args.push('--focus');
  herdr(args);
}

/** True when the plugin refuses to act because it is already in a container. */
export function notificationSupported() {
  return tryRun(HERDR_BIN, ['notification', 'show', '--help']).status === 0;
}
