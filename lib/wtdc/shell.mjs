#!/usr/bin/env node
// Dispatcher installed as Herdr's `terminal.default_shell`.
//
// Herdr spawns this instead of a real shell for every new pane, tab and
// terminal. If the pane's working directory belongs to a worktree this plugin
// provisioned, the shell is `docker exec` into that worktree's container, so
// every terminal opened in that worktree lands inside the container. Anywhere
// else it execs the real shell, so it is a no-op for every other workspace.
//
// This is what lets a worktree stay a normal local Herdr worktree, grouped
// under its repository, instead of becoming a separate saved SSH machine.
// A container-hosted Herdr server is the only way to get a full Herdr session
// (splits, agents, layouts) inside a container, but every workspace it owns is
// rendered beneath that server's machine node in the sidebar. Running the panes
// on the host server and pointing their shell here keeps Herdr's own worktree
// grouping, and agent detection still works because Herdr classifies agents
// from the screen buffer rather than the process tree.
//
// Installed by the `install-shell` action, which also prints the single config
// line this needs. Nothing here edits Herdr's configuration on its own.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_STATE_FILE } from "./context.mjs";
import { findByCwd } from "./state.mjs";
import { containerIsRunning, containerWorkspace } from "./devcontainer.mjs";

const selfPath = fileURLToPath(import.meta.url);

function sameFile(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// A pane must never be blocked by a slow or broken lookup. Anything that goes
// wrong drops through to the real shell, which is always safe.
function realShell() {
  let shell = process.env.WTDC_REAL_SHELL || process.env.SHELL || "/bin/sh";
  if (!path.isAbsolute(shell)) {
    const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", shell], { encoding: "utf8" });
    shell = (found.stdout || "").trim() || shell;
  }
  // A shell that resolves back to this script would fork-bomb the machine.
  if (sameFile(shell, selfPath)) shell = "/bin/sh";
  return shell;
}

function fallback(args) {
  const result = spawnSync(realShell(), args, { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

function stateFile() {
  return process.env.WTDC_STATE_FILE || DEFAULT_STATE_FILE;
}

function hasDocker() {
  return spawnSync("sh", ["-c", "command -v docker"], { stdio: "ignore" }).status === 0;
}

// Resolve the container's home directory. `docker exec -u` does not reliably
// derive HOME, which breaks login shells and anything reading ~/.gitconfig,
// credentials, or agent config.
function remoteHome(containerId, user) {
  const res = spawnSync("docker", ["exec", containerId, "getent", "passwd", user], {
    encoding: "utf8",
  });
  const home = (res.stdout || "").split(":")[5];
  if (home) return home.trim();
  return user === "root" ? "/root" : `/home/${user}`;
}

/**
 * Build the `docker exec` argv for a resolved entry, or null when this pane
 * should not be redirected.
 *
 * Exported so the path translation and argument order can be tested without a
 * PTY, which is the only way this file's decisions are actually reachable.
 */
export function planExec(entry, cwd) {
  if (!entry || !entry.container_id) return null;
  if (!containerIsRunning(entry.container_id)) return { missing: true, entry };

  const { container_id: cid, remote_user: user, checkout_path: checkout } = entry;

  // Translate the host cwd into the container's view of the same directory: the
  // worktree is mounted inside the container, so it is the container workspace
  // plus whatever the pane had appended.
  let workdir = entry.container_workspace || containerWorkspace(checkout) || "";
  if (workdir && checkout && cwd !== checkout) {
    workdir += cwd.slice(checkout.length);
  }

  const dockerArgs = ["exec", "-it"];
  if (user) dockerArgs.push("-u", user, "-e", `HOME=${remoteHome(cid, user)}`);
  // The plugin's CLI may also be available inside the container. Carry an explicit
  // guard into that shell so it cannot try to provision another container from there.
  dockerArgs.push("-e", "WTDC_IN_CONTAINER=1");
  if (workdir) dockerArgs.push("-w", workdir);
  // Fall back through bash to sh so a minimal image still gets a shell. `-l` is
  // dropped deliberately: the container has no host profile to be consistent
  // with, and a login shell that cannot resolve a home is worse than a plain one.
  dockerArgs.push(
    cid,
    "sh",
    "-lc",
    "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi",
  );

  return { args: dockerArgs, workdir, containerId: cid };
}

function main() {
  const args = process.argv.slice(2);

  if (!fs.existsSync(stateFile())) return fallback(args);
  if (!hasDocker()) return fallback(args);
  // Only interactive panes get a shell worth replacing. A non-tty invocation is
  // a script or a hook, and hijacking it would break the caller.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback(args);

  let entry;
  try {
    entry = findByCwd(process.cwd());
  } catch {
    // Unreadable or corrupt state must not strand the user without a shell.
    return fallback(args);
  }
  if (!entry || !entry.container_id) return fallback(args);

  const plan = planExec(entry, process.cwd());
  if (!plan) return fallback(args);
  if (plan.missing) {
    const checkout = entry.checkout_path || process.cwd();
    process.stderr.write(
      `\x1b[33mworktree-devcontainer:\x1b[0m the container for ${checkout} is not running.\n` +
        "Re-create it from that worktree, or run: herdr plugin action invoke worktree-devcontainer.provision\n" +
        "Starting a host shell instead.\n\n",
    );
    return fallback(args);
  }

  process.stderr.write("\x1b[2J\x1b[H");
  process.stderr.write(
    `\x1b[36m▸ dev container\x1b[0m  ${path.basename(entry.checkout_path || process.cwd())}\n`,
  );
  process.stderr.write(`\x1b[2m${plan.workdir}\x1b[0m\n\n`);

  const result = spawnSync("docker", plan.args, { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

// Only run when executed, not when imported by a test.
if (process.argv[1] && sameFile(process.argv[1], selfPath)) {
  main();
}
