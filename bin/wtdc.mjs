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
//   install-shell          configure Herdr to use the shell dispatcher
//   action <id>            plugin action entry point
//
// See README.md for configuration.

import fs from "node:fs";
import path from "node:path";
import { ROOT, insideContainer } from "./../lib/wtdc/context.mjs";
import { loadConfig, seedUserConfig } from "./../lib/wtdc/config.mjs";
import { tryRun, have } from "./../lib/wtdc/run.mjs";
import { step, ok, info, detail, warn, die, notify } from "./../lib/wtdc/ui.mjs";
import { setTomlKey } from "./../lib/wtdc/toml.mjs";
import { emit, phaseStart } from "./../lib/wtdc/progress.mjs";
import * as state from "./../lib/wtdc/state.mjs";
import * as dc from "./../lib/wtdc/devcontainer.mjs";
import * as herdr from "./../lib/wtdc/herdr.mjs";
import * as imageInfo from "./../lib/wtdc/imageInfo.mjs";

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** Repository name, used to keep machine/container names unique across repos. */
function projectFor(checkout) {
  const res = tryRun("git", [
    "-C",
    checkout,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const gd = (res.stdout || "").trim();
  return gd ? path.basename(path.dirname(gd)) : "";
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
  return h.toString(16).padStart(8, "0");
}

function containerNameFor(slug, project) {
  const parts = [project || "wt", slug].filter(Boolean);
  return `herdr-${parts.join("-")}`.slice(0, 63);
}

function requireHostTools() {
  for (const tool of ["docker", "git", "devcontainer"]) {
    if (!have(tool, tool === "docker" ? ["--version"] : ["--help"])) {
      die(`${tool} is required but was not found on PATH`);
    }
  }
}

function requireConfig(checkout, config) {
  requireHostTools();
  if (!fs.existsSync(checkout)) die(`worktree path does not exist: ${checkout}`);

  // The base directory can be the main checkout rather than this worktree, so say which one
  // was searched when there is nothing to find. "no devcontainer config in <worktree>" is
  // actively misleading when the file being looked for was never going to be in the worktree.
  const base = dc.configBaseDir(checkout, config);
  const found = dc.findConfig(base, config.WTDC_CONFIG_CANDIDATES);
  if (!found) {
    const where = base === checkout ? checkout : `${base} (the main checkout, for ${checkout})`;
    die(`no devcontainer config in ${where} (looked for: ${config.WTDC_CONFIG_CANDIDATES})`);
  }
  return found;
}

// ------------------------------------------------------------------ provision

/**
 * Prefix the workspace label Herdr already renders in the default sidebar.
 * Custom metadata tokens only render when the user adds them to their sidebar layout.
 */
function markContainerised(workspaceId, config) {
  const icon = config.WTDC_CONTAINER_ICON || "";
  if (!workspaceId || !icon) return null;
  const originalLabel = herdr.workspaceLabel(workspaceId);
  if (!originalLabel) return null;
  if (originalLabel.startsWith(`${icon} `)) {
    return {
      marked_workspace_id: workspaceId,
      original_label: originalLabel.slice(icon.length + 1),
      marked_label: originalLabel,
    };
  }
  const markedLabel = `${icon} ${originalLabel}`;
  if (!herdr.renameWorkspace(workspaceId, markedLabel)) {
    warn(`could not mark workspace ${workspaceId} in the sidebar`);
    return null;
  }
  // Remove the token left by older plugin versions so custom layouts do not show it twice.
  herdr.clearWorkspaceToken(workspaceId, "name");
  return {
    marked_workspace_id: workspaceId,
    original_label: originalLabel,
    marked_label: markedLabel,
  };
}

function unmarkContainerised(entry) {
  const workspaceId = herdr.workspaceIdFor(entry.checkout_path) || entry.marked_workspace_id;
  if (!workspaceId) return;
  const currentLabel = herdr.workspaceLabel(workspaceId);
  // A user rename takes precedence over the plugin's saved label.
  if (entry.marked_label && currentLabel === entry.marked_label) {
    if (!herdr.renameWorkspace(workspaceId, entry.original_label)) {
      warn(`could not restore workspace ${workspaceId} label`);
    }
  }
  herdr.clearWorkspaceToken(workspaceId, "name");
}

function provisionFailed() {
  const checkout = process.env.WTDC_PROVISION_CHECKOUT;
  const label = process.env.WTDC_PROVISION_LABEL || "worktree";
  if (checkout && state.has(checkout)) {
    // Drop the entry so the worktree stays retryable: hook_created skips
    // worktrees that already have state, so a half-written entry would stop the
    // prompt from ever appearing again.
    state.del(checkout);
  }
  notify(
    `Dev container failed: ${label}`,
    "the build tab has the error; provision it again",
    "request",
  );
}

function provision(checkout, workspaceId = "", labelArg = "") {
  const config = loadConfig();
  const label = labelArg || path.basename(checkout);
  // Set by panes/boot.mjs, which is showing the progress and will hand its own pane to
  // the container shell when this returns.
  const handedOver = process.env.WTDC_HANDOFF === "1";

  process.env.WTDC_PROVISION_LABEL = label;
  process.env.WTDC_PROVISION_CHECKOUT = checkout;
  process.on("exit", provisionFailed);

  const src = requireConfig(checkout, config);
  const slug = uniqueSlug(slugify(label), checkout);
  const project = projectFor(checkout);
  const merged = dc.mergedPathFor(checkout);

  emit("inspect", phaseStart("inspect") * 100, label);
  step(`Preparing dev container for ${label}`);
  detail(`worktree   ${checkout}`);
  detail(`project    ${project || "unknown"}`);
  detail(`config     ${src}`);
  detail(`merged     ${merged}`);

  const prebuilt = dc.prebuiltImage(config);
  if (prebuilt) detail(`image     ${prebuilt}`);

  // A tag can be multi-arch and still resolve, on this machine, to a variant this machine
  // cannot execute — an explicit `pull --platform`, a build run for another arch, or a
  // copied cache. The Dev Container CLI's uid-remap build does `FROM` on that image, the
  // shell inside it will not exec, and the failure surfaces as `exec format error` buried
  // in twenty lines of minified stack trace. Say it here, where the cause is still the
  // whole story, and give the command that fixes it.
  //
  // Before anything is written, so a refusal leaves no merged config and no state entry
  // behind: there was no build, so there is nothing to clean up.
  //
  // Best-effort by design. A config this cannot plan is `buildMerged`'s to report, a few
  // lines below and with a far better message than anything this could invent — so a
  // failure here is not a failure, it is nothing to check.
  try {
    const planned = dc.planProvision(src, config, checkout);
    if (imageInfo.platformMismatch(planned.image)) {
      die(
        `${planned.image} is on this machine as ${imageInfo.localPlatform(planned.image)}, ` +
          `but this host is ${imageInfo.hostPlatform()}.

   Nothing here can execute it, and provisioning fails a long way from the
   cause — the devcontainer CLI builds a uid-remapped copy with FROM on that
   image, and the shell inside the copy does not run. One command fixes it:

     docker pull --platform ${imageInfo.hostPlatform()} ${planned.image}`,
      );
    }
  } catch {
    // Nothing to check. `die` above cannot land here — it exits rather than throws.
  }

  emit("merge", phaseStart("merge") * 100, path.basename(merged));
  try {
    dc.buildMerged(src, merged, config, checkout, (ref) => {
      emit("pull", phaseStart("pull") * 100, ref);
      step(`Pulling image ${ref}`);
    });
  } catch (err) {
    die(`could not merge ${src} into ${merged}: ${err.message}`);
  }

  // Whether this provision builds an image is a property of the *merged* config, not of
  // the plugin's settings: the CLI derives a per-workspace image when the config declares
  // features, and does nothing extra when it declares none. Warning on "no prebuilt image
  // configured" got this backwards — with no template set that was every provision,
  // including the ones that are a `docker run`, so it cried wolf on the fast path.
  const derived = Object.keys(JSON.parse(fs.readFileSync(merged, "utf8")).features || {});
  if (derived.length) {
    warn(
      `this build derives a per-worktree image from ${derived.length} feature(s) ` +
        "(~25s warm, minutes cold)",
    );
    detail("to skip that, name a prebuilt image in your devcontainer.json, or set WTDC_TEMPLATE");
    if (fs.existsSync(path.join(ROOT, "images", "manifest.json"))) {
      detail("  base | node | python | rust  (see images/README.md)");
    }
  }

  // Persist before the slow work, so a crash during the build still leaves
  // teardown able to find and clean up the merged config.
  state.set(checkout, {
    label,
    slug,
    project,
    checkout_path: checkout,
    container_id: "",
    container_name: "",
    container_workspace: "",
    remote_user: "",
    merged_config: merged,
    source_config: src,
  });

  step("Building and starting the container (this can take a while)");
  emit("up", phaseStart("up") * 100);
  const up = dc.up(checkout, merged, config, (containerId) => {
    emit("ready", phaseStart("ready") * 100, containerId ? containerId.slice(0, 12) : "");
  });
  if (!up.containerId) die("devcontainer up did not report a container id");

  const cname = containerNameFor(slug, project);
  if (tryRun("docker", ["rename", up.containerId, cname]).status === 0) {
    state.patch(checkout, { container_name: cname });
  } else {
    warn(`could not rename container to ${cname}`);
  }

  const remoteUser =
    up.remoteUser ||
    (tryRun("docker", ["inspect", "-f", "{{.Config.User}}", up.containerId]).stdout || "").trim() ||
    "";

  emit("finish", phaseStart("finish") * 100, cname);

  state.patch(checkout, {
    container_id: up.containerId,
    container_workspace: up.containerWorkspace,
    remote_user: remoteUser,
  });

  // The worktree stays a local Herdr worktree; the container is reached through
  // the shell dispatcher. Mark the row so the sidebar shows which worktrees are
  // containerised, without occupying a machine node.
  const marker = markContainerised(workspaceId || herdr.workspaceIdFor(checkout), config);
  if (marker) state.patch(checkout, marker);

  info("");
  ok(`${label} is running in a dev container`);
  detail(`container: ${cname} (${up.containerId.slice(0, 12)})`);
  detail(`container cwd: ${up.containerWorkspace || "<default>"}`);

  if (config.WTDC_OPEN_CONTAINER_PANE === "1" && !handedOver) {
    herdr.openPluginPane("container", {
      placement: "tab",
      workspace: workspaceId || undefined,
      cwd: checkout,
      env: {
        WTDC_CONTAINER_ID: up.containerId,
        WTDC_CONTAINER_WORKSPACE: up.containerWorkspace,
        WTDC_CONTAINER_USER: remoteUser,
        WTDC_LABEL: label,
        WTDC_CHECKOUT: checkout,
      },
      focus: true,
    });
    ok("opened the container terminal in this worktree");
  } else if (handedOver) {
    // A setup screen is on screen (panes/boot.mjs runs this process) and turns its own
    // pane into the container terminal when the build finishes. Opening a tab as well
    // would leave two terminals in the worktree and no way to tell which is real.
    detail("the setup screen is turning itself into the container terminal");
  } else {
    detail("container tab opening is disabled by WTDC_OPEN_CONTAINER_PANE=0");
  }

  notify(`Dev container ready: ${label}`, "the container terminal is attached", "done");
  emit("done", 100, cname);
  process.removeListener("exit", provisionFailed);
}

// ------------------------------------------------------------------- teardown

function teardown(checkout, force = false) {
  const config = loadConfig();
  const entry = state.get(checkout);
  if (!entry) {
    info(`no dev container tracked for ${checkout}`);
    return;
  }

  if (config.WTDC_KEEP_CONTAINER === "1" && !force) {
    warn(
      `WTDC_KEEP_CONTAINER=1: leaving container ${(entry.container_id || "").slice(0, 12)} running`,
    );
  } else {
    step("Destroying the container");
    dc.down(checkout, entry.merged_config, entry.container_id);
  }

  if (entry.merged_config) {
    try {
      fs.rmSync(path.dirname(entry.merged_config), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }

  // Take the marker off, unless the container was deliberately kept — in which case it is
  // still there, and the row should still say so.
  if (config.WTDC_KEEP_CONTAINER !== "1" || force) {
    unmarkContainerised(entry);
  }

  state.del(checkout);
  ok("torn down");
}

// --------------------------------------------------------------------- status

function status() {
  const entries = state.list();
  process.stderr.write(`\x1b[34mdev containers\x1b[0m\n`);
  if (entries.length === 0) {
    process.stderr.write("  \x1b[2mnone tracked\x1b[0m\n");
    return;
  }
  for (const e of entries) {
    const alive = dc.containerIsRunning(e.container_id) ? "running" : "not running";
    const label = e.label || path.basename(e.checkout_path);
    process.stderr.write(`  ${label.padEnd(30)} ${alive.padEnd(12)} ${e.checkout_path}\n`);
  }
}

// ---------------------------------------------------------------------- hooks

function hookCreated() {
  const config = loadConfig();
  if (config.WTDC_ENABLED !== "1") return;

  const checkout = herdr.eventWorktreePath();
  if (!checkout) return;
  const workspaceId = herdr.eventWorkspaceId();
  const label = herdr.eventWorktreeLabel() || path.basename(checkout);
  const repo = herdr.eventRepoName();

  if (state.has(checkout)) return;
  if (!dc.resolveConfigPath(checkout, config)) {
    const base = dc.configBaseDir(checkout, config);
    info(
      `no devcontainer config in ${base === checkout ? checkout : base + " (main checkout)"}; skipping`,
    );
    return;
  }

  if (config.WTDC_ON_CREATE === "never") return;

  const env = {
    WTDC_CHECKOUT: checkout,
    WTDC_WORKSPACE: workspaceId,
    WTDC_LABEL: label,
    WTDC_REPO: repo,
    // Captured here, before the prompt overlay exists: a pane opened untargeted
    // resolves to the active pane, so afterwards the worktree's own shell and
    // our own overlay are indistinguishable. The boot screen has to zoom the
    // former, or it opens as a second tab and leaves the worktree's pane on the
    // host shell — which is what "it opened in another terminal" looked like.
    WTDC_TARGET_PANE: herdr.shellPaneOf(workspaceId),
  };

  if (config.WTDC_ON_CREATE === "auto") {
    herdr.openPluginPane("boot", {
      placement: "zoomed",
      workspace: workspaceId || undefined,
      cwd: checkout,
      env,
      focus: true,
      pane: env.WTDC_TARGET_PANE,
    });
  } else {
    herdr.openPluginPane("prompt", {
      placement: "overlay",
      workspace: workspaceId || undefined,
      cwd: checkout,
      env,
    });
  }
}

function hookRemoved() {
  const config = loadConfig();
  if (config.WTDC_ENABLED !== "1") return;

  const checkout = herdr.eventWorktreePath();
  if (!checkout) return;

  if (state.has(checkout)) teardown(checkout);
  if (config.WTDC_KEEP_CONTAINER === "1") return;
  // Sweep by Docker label, so a build that failed before state was written is
  // still cleaned up.
  const removed = dc.removeOrphans(checkout);
  if (removed > 0) ok(`removed ${removed} orphaned container(s) for ${checkout}`);
}

function startup() {
  const config = loadConfig();
  if (config.WTDC_ENABLED !== "1") return;
  if (!have("docker", ["--version"])) return;

  const entries = state.list();
  let running = 0;
  for (const entry of entries) {
    if (!dc.containerIsRunning(entry.container_id)) continue;
    running += 1;
    const workspaceId = herdr.workspaceIdFor(entry.checkout_path);
    if (!workspaceId) continue;
    const currentLabel = herdr.workspaceLabel(workspaceId);
    if (entry.marked_label && currentLabel === entry.marked_label) continue;
    // Preserve a label the user changed after the plugin marked it.
    if (entry.marked_label && currentLabel !== entry.original_label) continue;
    const marker = markContainerised(workspaceId, config);
    if (marker) state.patch(entry.checkout_path, marker);
  }
  info(`dev containers tracked: ${entries.length}, running: ${running}`);
}

// ------------------------------------------------------------------- actions

/**
 * Point Herdr's `terminal.default_shell` at the dispatcher.
 *
 * This one line is the whole integration between the plugin and Herdr's pane
 * spawning: without it every new pane runs the user's own shell, so a worktree
 * that has a running container still gives you a host terminal. Printing the line
 * and trusting the user to paste it is how that stays broken — a terminal opened
 * later looks exactly like a terminal opened before the container existed, and
 * nothing anywhere reports the difference. So the action edits the file, keeps a
 * backup, and says what it did. `WTDC_CONFIG_FILE` points it elsewhere for tests
 * and for anyone whose Herdr keeps its config somewhere unusual.
 */
function installShell() {
  const shellPath = path.join(ROOT, "lib", "wtdc", "shell.mjs");
  const file =
    process.env.WTDC_CONFIG_FILE ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"),
      "herdr",
      "config.toml",
    );
  const stateFile =
    process.env.WTDC_STATE_FILE ||
    path.join(
      process.env.XDG_STATE_HOME || path.join(process.env.HOME || "", ".local", "state"),
      "herdr",
      "plugins",
      "worktree-devcontainer",
      "state.json",
    );

  let original = "";
  try {
    original = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stdout.write(`error: could not read ${file}: ${err.message}\n`);
      return 1;
    }
  }

  const edit = setTomlKey(original, "terminal", "default_shell", shellPath);
  if (!edit.ok) {
    process.stdout.write(
      `error: ${file} — ${edit.reason},\n` +
        "so this plugin will not touch it. Set the key by hand:\n\n" +
        `  [terminal]\n  default_shell = "${shellPath}"\n\nthen run: herdr server reload-config\n`,
    );
    return 1;
  }

  if (!edit.changed) {
    process.stdout.write(`already installed: terminal.default_shell is ${shellPath}\n`);
  } else {
    if (original !== "") {
      const backup = `${file}.bak-before-wtdc`;
      try {
        fs.writeFileSync(backup, original);
      } catch (err) {
        process.stdout.write(`error: could not back up ${file} to ${backup}: ${err.message}\n`);
        return 1;
      }
      process.stdout.write(`backed up ${file} to ${backup}\n`);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, edit.text);
    } catch (err) {
      process.stdout.write(
        `error: could not write ${file}: ${err.message}\n\n` +
          "Add this by hand instead:\n\n" +
          `  [terminal]\n  default_shell = "${shellPath}"\n\nthen run: herdr server reload-config\n`,
      );
      return 1;
    }
    process.stdout.write(`set terminal.default_shell = ${shellPath}\n`);
  }

  process.stdout.write(`
terminal.default_shell is the only thing that decides where a new pane runs.
With it pointing at the dispatcher, a pane whose working directory is a
provisioned worktree is \`docker exec\` into that worktree's container, and a pane
anywhere else is your real $SHELL, unchanged.

It reads ${stateFile}
`);

  // Reload here rather than printing a line and hoping: the failure this prevents is
  // silent, so the step people forget is the one that has to be automatic.
  if (herdr.reloadConfig()) {
    process.stdout.write("\nreloaded the server config, so new panes already use it\n");
  } else {
    process.stdout.write("\nnow run:  herdr server reload-config\n");
  }
  return 0;
}

function actionInstallShell() {
  const rc = installShell();
  if (rc !== 0) process.exitCode = rc;
}

function actionProvision() {
  const checkout = herdr.contextWorktree();
  if (!checkout) die("this action must be invoked from a worktree workspace");
  const workspaceId = process.env.HERDR_WORKSPACE_ID || "";
  provision(checkout, workspaceId, herdr.workspaceLabel(workspaceId) || path.basename(checkout));
}

function actionTeardown() {
  const checkout = herdr.contextWorktree();
  if (!checkout) die("this action must be invoked from a worktree workspace");
  teardown(checkout);
}

// ------------------------------------------------------------------ boot hand-off

const sleepMs = (ms) => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
};

/**
 * Open the setup screen, once the prompt overlay is out of the way.
 *
 * Run detached by panes/prompt.mjs. The wait is the whole point: an overlay
 * makes itself the active pane, and a pane opened with no target lands on the
 * active one. Opening the boot screen before the prompt exits therefore stacks
 * it on top of the question, and it disappears a moment later — which is what
 * "I pressed yes and nothing happened" actually was.
 */
function bootLaunch(checkout, workspaceId, label, targetPane) {
  if (!workspaceId) {
    warn("no workspace for the new worktree; the setup screen will open wherever you are");
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const panes = herdr.panesIn(workspaceId);
    if (!panes.some((p) => p.label === herdr.PROMPT_PANE_TITLE)) break;
    // Also stop waiting once the pane this was going to zoom has gone: there is
    // nothing left to wait for, and the target is resolved again below anyway.
    if (targetPane && !panes.some((p) => p.pane_id === targetPane)) break;
    sleepMs(100);
  }

  // The pane the hook captured is a preference, not a fact. The user can close the
  // worktree's shell while the question is up, and `--target-pane` rejects an id that
  // is not there — which would leave them having answered "yes" to nothing at all.
  const pane = herdr.resolveTargetPane(workspaceId, targetPane);
  if (!pane) {
    warn(
      "the worktree has no pane left to show the setup screen in; it will open wherever you are",
    );
  }

  // An image typed into the prompt travels with the build, so the setup screen has to be
  // told. Environment only and only when one was given, so the config's own image is used
  // whenever the field was left as a placeholder.
  const override = (process.env.WTDC_OVERRIDE_IMAGE || "").trim();

  herdr.openPluginPane("boot", {
    placement: "zoomed",
    workspace: workspaceId || undefined,
    cwd: checkout,
    // The worktree's own pane, captured by the hook before this plugin opened
    // anything. Zooming it is what makes the setup screen take over the
    // worktree instead of appearing in a tab of its own.
    pane,
    env: {
      WTDC_CHECKOUT: checkout,
      WTDC_LABEL: label,
      WTDC_WORKSPACE: workspaceId,
      WTDC_TARGET_PANE: pane,
      ...(override ? { WTDC_OVERRIDE_IMAGE: override } : {}),
    },
  });
}

// ---------------------------------------------------------------------- entry

function main() {
  // Shells entered through the dispatcher carry WTDC_IN_CONTAINER=1, so a copy of
  // this CLI invoked there cannot try to provision another container.
  if (insideContainer()) {
    process.stdout.write("worktree-devcontainer: disabled inside a dev container\n");
    return;
  }

  // Seed the user's config.env before dispatching, so a fresh install gets its
  // editable copy from whichever command happens to run first. loadConfig()
  // also seeds, but only the commands that need a setting ever reach it.
  seedUserConfig();

  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "hook-created":
      return hookCreated();
    case "hook-removed":
      return hookRemoved();
    case "startup":
      return startup();
    case "provision": {
      if (!rest[0]) die("worktree path required");
      return provision(rest[0], rest[1] || "", rest[2] || "");
    }
    case "teardown": {
      if (!rest[0]) die("worktree path required");
      return teardown(rest[0], rest[1] === "--force" || rest[1] === "1");
    }
    case "status":
      return status();
    case "boot-launch": {
      if (!rest[0]) die("worktree path required");
      return bootLaunch(rest[0], rest[1] || "", rest[2] || "", rest[3] || "");
    }
    case "install-shell":
      return actionInstallShell();
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(`
worktree-devcontainer — run each Herdr worktree's devcontainer and open
terminals inside it, keeping the worktree grouped under its repo.

  hook-created            event hook: offer to provision a new worktree
  hook-removed            event hook: tear down a removed worktree
  startup                 startup hook: report tracked containers
  provision <path> [ws] [label]
  teardown  <path> [--force]
  status
  install-shell           configure Herdr to use the shell dispatcher
  action <id>             plugin action entry point
`);
      return;
    case "action": {
      const id = rest[0];
      if (id === "provision") return actionProvision();
      if (id === "teardown") return actionTeardown();
      if (id === "status") return status();
      if (id === "install-shell") return actionInstallShell();
      return die(`unknown action: ${id || ""}`);
    }
    default:
      return die(`unknown command: ${cmd || "(none)"} (try: help)`);
  }
}

main();
