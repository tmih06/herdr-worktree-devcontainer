// Calls back into Herdr.
//
// Plugins have no privileged API — the whole CLI is available — so this module
// is just a typed seam over the commands this plugin uses, plus the event and
// context shapes Herdr injects.

import { HERDR_BIN } from "./context.mjs";
import { tryRun } from "./run.mjs";
import { warn } from "./ui.mjs";

/** Run a herdr command, returning trimmed stdout. Returns '' on any failure. */
export function herdr(args, opts = {}) {
  const res = tryRun(HERDR_BIN, args, opts);
  return res.status === 0 ? (res.stdout || "").trim() : "";
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
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
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
  const e = parseEnvJson("HERDR_PLUGIN_EVENT_JSON");
  if (!e) return "";
  return firstDefined(e, [
    ["data", "worktree", "path"],
    ["worktree", "path"],
    ["data", "workspace", "worktree", "checkout_path"],
    ["workspace", "worktree", "checkout_path"],
  ]);
}

export function eventWorkspaceId() {
  const e = parseEnvJson("HERDR_PLUGIN_EVENT_JSON");
  if (!e) return "";
  return firstDefined(e, [
    ["data", "workspace", "workspace_id"],
    ["workspace", "workspace_id"],
    ["data", "workspace_id"],
    ["workspace_id"],
  ]);
}

export function eventWorktreeLabel() {
  const e = parseEnvJson("HERDR_PLUGIN_EVENT_JSON");
  if (!e) return "";
  return firstDefined(e, [
    ["data", "worktree", "label"],
    ["worktree", "label"],
  ]);
}

export function eventRepoName() {
  const e = parseEnvJson("HERDR_PLUGIN_EVENT_JSON");
  if (!e) return "";
  return firstDefined(e, [
    ["data", "workspace", "worktree", "repo_name"],
    ["workspace", "worktree", "repo_name"],
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
  const ctx = parseEnvJson("HERDR_PLUGIN_CONTEXT_JSON");
  const fromCtx = ctx ? firstDefined(ctx, [["worktree", "checkout_path"]]) : "";
  if (fromCtx) return fromCtx;

  const ws = process.env.HERDR_WORKSPACE_ID;
  if (!ws) return "";
  const doc = herdrJson(["workspace", "get", ws]);
  return firstDefined(doc || {}, [["result", "workspace", "worktree", "checkout_path"]]);
}

/** Projects without Herdr Git metadata resolve through their own active tab's cwd. */
export function contextCheckout() {
  const checkout = contextWorktree();
  if (checkout) return checkout;
  const ctx = parseEnvJson("HERDR_PLUGIN_CONTEXT_JSON");
  const direct = ctx ? firstDefined(ctx, [["cwd"], ["workspace", "cwd"]]) : "";
  if (direct) return direct;
  const workspaceId = process.env.HERDR_WORKSPACE_ID || ctx?.workspace_id;
  if (!workspaceId) return "";
  const workspace = herdrJson(["workspace", "get", workspaceId])?.result?.workspace;
  const panes = herdrJson(["pane", "list", "--workspace", workspaceId])?.result?.panes || [];
  const local = panes.filter((pane) => pane.workspace_id === workspaceId);
  const pane = local.find((p) => p.tab_id === workspace?.active_tab_id) || local[0];
  return pane?.cwd || "";
}

export function workspaceLabel(workspaceId) {
  const doc = herdrJson(["workspace", "get", workspaceId]);
  return firstDefined(doc || {}, [["result", "workspace", "label"]]);
}

export function renameWorkspace(workspaceId, label) {
  if (!workspaceId) return false;
  return tryRun(HERDR_BIN, ["workspace", "rename", workspaceId, label]).status === 0;
}

export function focusWorkspace(workspaceId) {
  if (!workspaceId) return false;
  return tryRun(HERDR_BIN, ["workspace", "focus", workspaceId]).status === 0;
}

export function closeWorkspace(workspaceId, { group = false } = {}) {
  if (!workspaceId) return false;
  const args = ["workspace", "close", workspaceId];
  if (group) args.push("--group");
  return tryRun(HERDR_BIN, args).status === 0;
}

/** Remove the old sidebar token left by previous plugin versions. */
export function clearWorkspaceToken(workspaceId, name, source = "wtdc") {
  if (!workspaceId) return false;
  return (
    tryRun(HERDR_BIN, [
      "workspace",
      "report-metadata",
      workspaceId,
      "--source",
      source,
      "--clear-token",
      name,
    ]).status === 0
  );
}

const PLACEMENT_FLAG = { overlay: "overlay", tab: "tab", split: "split", zoomed: "zoomed" };

/**
 * The title herdr-plugin.toml gives the prompt overlay.
 *
 * bootLaunch waits for a pane carrying this title to disappear before it opens the
 * setup screen, so the two must not drift apart; tests/unit.test.mjs reads the manifest
 * to check that they have not.
 */
export const PROMPT_PANE_TITLE = "Dev container?";

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
// An untargeted pane always resolves to the *active* pane, so a placement that cannot
// be targeted has to have its workspace focused first or it lands wherever the user
// happened to be. That is why the branches below focus rather than name, in the two
// cases where naming is not allowed.
const ACTIVE_TARGETED = new Set(["overlay", "popup"]);
const PANE_TARGETED = new Set(["zoomed", "split"]);

/** Open one of this plugin's declared panes. */
export function openPluginPane(
  entrypoint,
  { placement = "tab", workspace, cwd, env = {}, focus = false, pane = "" } = {},
) {
  const target = PLACEMENT_FLAG[placement] || placement;
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    process.env.HERDR_PLUGIN_ID || "worktree-devcontainer",
    "--entrypoint",
    entrypoint,
    "--placement",
    target,
  ];

  if (ACTIVE_TARGETED.has(target)) {
    if (workspace) focusWorkspace(workspace);
  } else if (PANE_TARGETED.has(target)) {
    if (pane) {
      // Only ever a pane we identified ourselves, captured before this plugin put
      // anything on screen. See shellPaneOf.
      args.push("--target-pane", pane);
      if (workspace) focusWorkspace(workspace);
    } else if (workspace) {
      // No pane to name: `--workspace` is rejected, and an untargeted pane resolves to
      // the active one, so focusing the workspace is the only way to aim it. Used when
      // the pane the caller captured has since been closed — naming a pane that is gone
      // is rejected outright, which is how "I pressed yes and nothing happened" happens.
      focusWorkspace(workspace);
    }
  } else if (workspace) {
    args.push("--workspace", workspace);
  }

  // `--cwd` is accepted by every placement except the ones that target the active pane,
  // so it is safe to send there: it sets where the pane starts, not which pane it
  // becomes.
  if (cwd && !ACTIVE_TARGETED.has(target)) args.push("--cwd", cwd);

  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null && v !== "") args.push("--env", `${k}=${v}`);
  }
  if (focus) args.push("--focus");

  // herdr() discards a failed command's output, so without this a pane that
  // never opened looked exactly like one that did.
  const res = tryRun(HERDR_BIN, args);
  if (res.status !== 0) {
    warn(
      `could not open the ${entrypoint} pane (${target}): ${(res.stderr || res.stdout || "").trim()}`,
    );
  }
  return res.status === 0;
}

/**
 * The workspace Herdr has open for a worktree checkout, or '' when it has none.
 *
 * Needed by the paths that are given a checkout path rather than a workspace — the
 * `teardown` action, and anything that runs after the fact — because the marker on the
 * worktree's row lives on the workspace.
 */
export function workspaceIdFor(checkout) {
  if (!checkout) return "";
  const doc = herdrJson(["worktree", "list", "--cwd", checkout]);
  const worktrees = (doc && (doc.worktrees || (doc.result && doc.result.worktrees))) || [];
  const hit = worktrees.find((w) => w.path === checkout);
  return (hit && hit.open_workspace_id) || "";
}

/** The panes of a workspace, as { pane_id, label, focused } records. */
export function panesIn(workspaceId) {
  if (!workspaceId) return [];
  const doc = herdrJson(["pane", "list"]);
  const panes = (doc && (doc.panes || (doc.result && doc.result.panes))) || [];
  return panes
    .filter((p) => p.workspace_id === workspaceId)
    .map((p) => ({ pane_id: p.pane_id, label: p.label || "", focused: !!p.focused }));
}

/**
 * The pane a new worktree's own shell lives in.
 *
 * Read before any plugin pane is opened, because a pane opened with no target
 * resolves to the active pane and so cannot be told apart from a shell afterwards.
 * That matters: the setup screen has to zoom *this* pane, so that it holds the screen
 * of the worktree it is setting up rather than appearing in a tab of its own.
 */
export function shellPaneOf(workspaceId) {
  const panes = panesIn(workspaceId);
  return panes.length ? panes[0].pane_id : "";
}

/**
 * The pane to aim a zoomed pane at, or '' when the workspace has none left.
 *
 * The id the caller captured goes stale: the user can close the worktree's shell while
 * the question is still on screen, and `--target-pane` rejects an id that is not there.
 * So the captured id is a preference, not a fact, and the workspace's own pane list is
 * the authority.
 */
export function resolveTargetPane(workspaceId, preferred = "") {
  const panes = panesIn(workspaceId);
  if (preferred && panes.some((p) => p.pane_id === preferred)) return preferred;
  return panes.length ? panes[0].pane_id : "";
}

/** Close a pane. Best effort: it reports false rather than throwing when it is already gone. */
export function closePane(paneId) {
  if (!paneId) return false;
  return tryRun(HERDR_BIN, ["pane", "close", paneId]).status === 0;
}

/** Retire the build pane's manual title and zoom before it becomes a normal terminal. */
export function clearSetupPane(paneId) {
  if (!paneId) return false;
  const renamed = tryRun(HERDR_BIN, ["pane", "rename", paneId, "--clear"]).status === 0;
  const unzoomed = tryRun(HERDR_BIN, ["pane", "zoom", paneId, "--off"]).status === 0;
  return renamed && unzoomed;
}

/** True when nothing but `paneId` is left standing in the workspace. */
export function isLastPane(workspaceId, paneId) {
  return panesIn(workspaceId).every((p) => p.pane_id === paneId);
}

/**
 * Open one of the user's own shells in a workspace, in a tab of its own.
 *
 * The dispatcher (lib/wtdc/shell.mjs) decides where that shell runs, so this is a host
 * shell anywhere the plugin has no container. A tab rather than a split because the
 * workspace is named outright: `pane split` places the new pane relative to a pane, and
 * the whole reason this is called is that the pane bookkeeping around it is not to be
 * trusted. `--no-focus` equivalent omitted on purpose — the pane asking is the one the
 * user is reading.
 */
export function openHostTab(workspaceId, cwd) {
  if (!workspaceId) return false;
  const args = ["tab", "create", "--workspace", workspaceId];
  if (cwd) args.push("--cwd", cwd);

  const res = tryRun(HERDR_BIN, args);
  if (res.status !== 0) {
    warn(`could not open a replacement shell: ${(res.stderr || res.stdout || "").trim()}`);
  }
  return res.status === 0;
}

/** True when the plugin refuses to act because it is already in a container. */
export function notificationSupported() {
  return tryRun(HERDR_BIN, ["notification", "show", "--help"]).status === 0;
}

/**
 * Re-read config.toml in the running server.
 *
 * Settings like `terminal.default_shell` are read when the server spawns a pane, so a
 * change is inert until this runs. Callers use it to avoid leaving a manual step
 * behind, because the thing that step enables fails silently when it is missed.
 */
export function reloadConfig() {
  return tryRun(HERDR_BIN, ["server", "reload-config"]).status === 0;
}
