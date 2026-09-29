// Process-wide context: where the plugin lives, where its state and config are,
// and which binaries to call.
//
// The plugin runs as several short-lived commands (event hooks, actions, panes),
// so there is no long-lived object graph. These are resolved per invocation
// from the environment Herdr injects.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

export const PLUGIN_ID = "worktree-devcontainer";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The installed or linked plugin directory. */
export const ROOT = process.env.HERDR_PLUGIN_ROOT
  ? path.resolve(process.env.HERDR_PLUGIN_ROOT)
  : path.resolve(here, "..", "..");

export const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  path.join(
    process.env.XDG_STATE_HOME || path.join(process.env.HOME || "", ".local", "state"),
    "herdr",
    "plugins",
    PLUGIN_ID,
  );

// The `config` segment is not optional: `herdr plugin config-dir <id>` reports
// ~/.config/herdr/plugins/config/<id>. A fallback that omits it reads a *different*
// directory and nothing reports the difference — a stale copy there kept overriding
// settings until this was fixed. Herdr sets HERDR_PLUGIN_CONFIG_DIR for panes, hooks and
// actions, so this only governs running bin/wtdc.mjs by hand.
export const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"),
    "herdr",
    "plugins",
    "config",
    PLUGIN_ID,
  );

// WTDC_STATE_FILE exists so the shell dispatcher and the plugin agree on one
// path when state lives outside the plugin's own directory. It is read per call
// by state.mjs rather than captured here, so the two cannot disagree.
export const DEFAULT_STATE_FILE = path.join(STATE_DIR, "state.json");

/** Prefer the running server's binary so calls hit the right socket. */
export const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

export const DEFAULT_CONFIG_FILE = path.join(ROOT, "config", "config.default.env");
export const USER_CONFIG_FILE = path.join(CONFIG_DIR, "config.env");

const startedAt = process.hrtime.bigint();

/** Seconds since this process started, for build timings. */
export function elapsed() {
  return Number((process.hrtime.bigint() - startedAt) / 1000000n) / 1000;
}

/**
 * True when this process is already running inside a provisioned container.
 *
 * The dispatcher hands the shell to `docker exec`, so a pane in a container
 * worktree has a different filesystem view than the host. Any command that
 * reaches back to the host must not be started from there.
 */
export function insideContainer() {
  if (process.env.WTDC_IN_CONTAINER === "1") return true;
  const marker = process.env.WTDC_IN_CONTAINER_MARKER;
  if (marker) {
    try {
      return fs.statSync(marker).isFile();
    } catch {
      return false;
    }
  }
  return false;
}
