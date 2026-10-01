#!/usr/bin/env node
// Blocking setup screen shown while a dev container is being provisioned.
//
// Opened zoomed over a new worktree's own pane, or in a new tab when reopening an
// existing workspace so its panes and layout are preserved. It holds that screen
// and the keyboard until the container is ready. The previous behaviour streamed
// `devcontainer up` into an ordinary tab, which meant the pane was easy to lose
// behind other tabs and the user had no way to tell a slow build from a hung
// one.
//
// When the build succeeds this pane *becomes* the container terminal instead of
// exiting. The worktree's first pane was spawned before the container existed, so
// it is a host shell; leaving that as the worktree's only terminal is what "the
// init one still not in dc" is. See handOver().
//
// The provisioner runs as a child process. Its stderr carries both ordinary
// output and tagged progress lines (see lib/wtdc/progress.mjs); this pane
// consumes the tags into the bar and keeps a tail of the rest, so a failure
// still shows the tool's own message.
//
// Keys:  Esc  cancel the build and close      (after the build) any key  close

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  barCells,
  DockerPullProgress,
  PHASES,
  isProgressLine,
  outputRows,
  parseProgressLine,
  phaseStart,
} from "../lib/wtdc/progress.mjs";
import { loadConfig } from "../lib/wtdc/config.mjs";
import { get as stateFor } from "../lib/wtdc/state.mjs";
import { enterContainerShell } from "../lib/wtdc/containerShell.mjs";
import { clearSetupPane, closePane, isLastPane, openHostTab } from "../lib/wtdc/herdr.mjs";
import { failureRows, setupLog } from "../lib/wtdc/setupLog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || path.resolve(here, "..");

const config = loadConfig();
const checkout = process.env.WTDC_CHECKOUT || "";
const label = process.env.WTDC_LABEL || path.basename(checkout);
const workspace = process.env.WTDC_WORKSPACE || process.env.HERDR_WORKSPACE_ID || "";
// The worktree's own shell pane, captured by the hook before this plugin put anything
// on screen. Nothing else may be closed on the strength of it.
const hostPane = process.env.WTDC_TARGET_PANE || "";
const selfPane = process.env.HERDR_PANE_ID || "";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

if (!checkout) {
  process.stdout.write("dev container: no worktree path was supplied\n");
  process.exit(1);
}

// ------------------------------------------------------------------- state

const state = {
  phase: PHASES[0].key,
  percent: 0,
  failed: false,
  cancelled: false,
  done: false,
  startedAt: Date.now(),
  log: [],
  pullProgress: new DockerPullProgress(),
};
const log = setupLog(checkout);

const byKey = Object.fromEntries(PHASES.map((p) => [p.key, p]));

function elapsed() {
  return ((Date.now() - state.startedAt) / 1000).toFixed(0);
}

const BAR_WIDTH = 34;
const LOG_LINES = 6;

function bar(percent) {
  const filled = barCells(percent, BAR_WIDTH);
  return `${C.cyan}${"█".repeat(filled)}${C.dim}${"░".repeat(BAR_WIDTH - filled)}${C.reset}`;
}

function render() {
  const current = byKey[state.phase] || PHASES[0];
  const lines = [];

  lines.push("");
  lines.push(`  ${C.cyan}Setting up the dev container${C.reset}  ${C.dim}${label}${C.reset}`);
  lines.push(`  ${C.dim}${checkout}${C.reset}`);
  lines.push("");

  lines.push(
    `  ${bar(state.percent)}  ${Math.round(state.percent)}%  ${C.dim}[${elapsed()}s]${C.reset}`,
  );
  lines.push("");
  lines.push(`  ${C.blue}›${C.reset} ${current.label}`);
  lines.push("");

  // Phase checklist, so a long build shows that it is moving through stages
  // rather than sitting on one line.
  for (const p of PHASES) {
    const end = (phaseStart(p.key) + p.share) * 100;
    const done = state.done || state.percent >= end;
    const active = !done && p.key === state.phase;
    const mark = done
      ? `${C.green}✔${C.reset}`
      : active
        ? `${C.cyan}▸${C.reset}`
        : `${C.dim}·${C.reset}`;
    lines.push(`   ${mark} ${done ? C.dim : active ? "" : C.dim}${p.label}${C.reset}`);
  }

  if (state.log.length) {
    lines.push("");
    lines.push(`  ${C.dim}── ${state.failed ? "output" : "detail"} ──${C.reset}`);
    for (const l of state.failed
      ? failureRows(state.log, LOG_LINES)
      : state.log.slice(-LOG_LINES)) {
      lines.push(`  ${state.failed ? C.red : C.dim}${l}${C.reset}`);
    }
  }

  lines.push("");
  if (state.failed) {
    lines.push(`  ${C.red}Setup failed.${C.reset} The worktree is untouched — fix the problem and`);
    lines.push(
      `  run ${C.dim}herdr plugin action invoke worktree-devcontainer.provision${C.reset} to retry.`,
    );
    if (log) lines.push(`  ${C.dim}Full log: ${log.file}${C.reset}`);
  } else if (state.cancelled) {
    lines.push(`  ${C.yellow}Cancelled.${C.reset} No container was created.`);
  } else if (state.done) {
    if (takesOverTerminal()) {
      lines.push(`  ${C.green}Ready.${C.reset} This terminal becomes the container in a moment.`);
    } else {
      lines.push(`  ${C.green}Ready.${C.reset} Every terminal you open in this worktree now runs`);
      lines.push(`  inside the container.`);
    }
  }

  lines.push("");
  if (!state.done && !state.failed && !state.cancelled) {
    lines.push(`  ${C.dim}Esc to cancel${C.reset}`);
  } else {
    lines.push(`  ${C.dim}press any key to close${C.reset}`);
  }
  lines.push("");

  // Home + clear rather than clear+home: repainting from the top avoids
  // smearing when the previous frame was taller than the next one.
  process.stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}\n`);
}

// ------------------------------------------------------------------- child

const bin = path.join(pluginRoot, "bin", "wtdc.mjs");
const child = spawn(process.execPath, [bin, "provision", checkout, workspace, label], {
  stdio: ["ignore", "pipe", "pipe"],
  // WTDC_HANDOFF tells the provisioner that a setup screen is on screen and will turn
  // itself into the container terminal, so it must not also open a container tab.
  env: { ...process.env, WTDC_PROGRESS: "1", WTDC_HANDOFF: "1" },
});

/** Fold one chunk of child output into the log tail. Both streams, not just
 *  stderr: wtdc prints some early-exit messages ("disabled inside a dev
 *  container", "no worktree path was supplied") to stdout. */
function consume(stream) {
  let partial = "";
  const show = (rows) => {
    for (const row of rows) {
      const line = row;
      if (!line) continue;
      if (isProgressLine(line)) {
        const p = parseProgressLine(line);
        if (!p) continue;
        if (p.phase === "done") {
          state.done = true;
          state.percent = 100;
          state.phase = "finish";
        } else {
          state.phase = p.phase;
          state.percent = Math.max(state.percent, p.percent);
          if (p.phase === "pull") state.pullProgress = new DockerPullProgress();
        }
      } else {
        // Strip the plugin's own leading indentation and colour so the tail
        // reads as one column.
        const clean = line
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
          .replace(/^\s+/, "")
          .trim();
        if (clean) {
          if (state.phase === "pull") {
            const fraction = state.pullProgress.update(clean);
            if (fraction !== null) {
              const pull = byKey.pull;
              const percent = (phaseStart("pull") + pull.share * fraction) * 100;
              state.percent = Math.max(state.percent, percent);
            }
          }
          state.log.push(clean);
          if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
        }
      }
    }
    render();
  };
  stream.on("data", (chunk) => {
    log?.append(chunk);
    const next = outputRows(partial, chunk.toString());
    partial = next.partial;
    show(next.rows);
  });
  stream.on("end", () => {
    if (partial) show([partial]);
  });
}

consume(child.stdout);
consume(child.stderr);

// ------------------------------------------------------------------ leaving

/**
 * Leave without taking the worktree's workspace with us.
 *
 * Herdr removes a workspace the moment its last pane closes, and a worktree whose
 * workspace is gone is a worktree the user cannot get back to from the sidebar — the
 * checkout is still on disk, which is the confusing part. This pane is the last one
 * whenever the worktree's shell is already gone: Herdr 0.9.0 is documented to give a
 * zoomed pane its target's place, the user can close the shell while the question is up,
 * or a host pane may never have existed. So check before every exit and leave a
 * replacement behind if there is nothing else.
 */
function leave(code) {
  if (workspace && selfPane && isLastPane(workspace, selfPane)) {
    openHostTab(workspace, checkout);
  }
  process.stdout.write("\x1b[?25h");
  process.exit(code);
}

/** True when this pane is going to become the container terminal. */
function takesOverTerminal() {
  return config.WTDC_OPEN_CONTAINER_PANE !== "0" && !!stateFor(checkout);
}

/**
 * Become the container terminal.
 *
 * Three things happen, in this order and deliberately:
 *
 *  1. The worktree's original shell pane is closed. It was spawned before the container
 *     existed, so it is a host shell, and the plugin's whole promise is that terminals in
 *     this worktree run in the container. Leaving it behind is the reported "the init one
 *     still not in dc". It is closed *after* this pane has something to replace it with,
 *     never before, so the workspace is never briefly empty.
 *
 *  2. Its setup title, zoom and keyboard handler are cleared. The process stays alive,
 *     so Herdr cannot retire those settings by observing a pane exit.
 *
 *  3. This pane enters the container, through the same planExec the dispatcher uses
 *     for every other pane. Handing the pane over rather than opening a second one and
 *     exiting is what makes the ordering above impossible to get wrong: there is no gap
 *     between "the setup screen goes" and "the container terminal exists", which is the
 *     gap in which a workspace disappears.
 */
function handOver() {
  const entry = stateFor(checkout);
  if (!entry) {
    // Say so where the user is looking: this screen is about to be replaced by
    // whatever was underneath it, and a bare exit would take the message with it.
    state.log.push(
      "the build reported success but recorded no container, so this pane was left alone",
    );
    render();
    return false;
  }

  // Only ever the pane the hook identified, and never this one.
  if (hostPane && hostPane !== selfPane && process.env.WTDC_PRESERVE_PANES !== "1")
    closePane(hostPane);

  // The process continues in this pane, so Herdr will not clear its setup title or
  // zoom on exit. Retire that UI explicitly and release setup's keyboard handler.
  clearSetupPane(selfPane);
  cleanup();
  process.stdout.write("\x1b[?25h");
  const status = enterContainerShell(entry, checkout, {
    label,
    note: "Connected with docker exec. Exit to close this terminal.",
  });
  // No guard on the way out: the shell this pane just ran has ended, exactly as it does
  // for any terminal, and a workspace whose last pane closed is the user's business.
  process.exit(status);
}

const finish = (code) => {
  clearInterval(tick);
  state.phase = "finish";
  state.done = code === 0;
  state.failed = code !== 0 && !state.cancelled;
  // A failed build is not 100% done. Jumping the bar to full and ticking every
  // phase claimed work that never happened.
  if (state.done) state.percent = 100;
  render();

  if (state.failed) {
    // A failure keeps the screen up. The whole point of holding the pane is
    // that the user can read what went wrong; exiting on the spot showed an
    // empty pane and took the only copy of the error with it. onKey closes it.
    // Without a terminal there is nobody to press a key, so leave anyway
    // rather than hold a pane open forever.
    if (!process.stdin.isTTY) setTimeout(() => leave(code || 1), 3000);
    return;
  }

  // Long enough to read the last frame, then hand the pane to the container. A
  // handover that cannot happen — the user asked for no container terminal, or
  // the state is missing — falls back to closing, which leaves the worktree's
  // own pane standing.
  setTimeout(() => {
    // handOver() only comes back when it could not be done; otherwise this pane
    // is a container terminal and does not return at all.
    if (takesOverTerminal()) handOver();
    leave(0);
  }, 600);
};

child.on("error", (err) => {
  state.failed = true;
  state.log.push(String(err.message || err));
  log?.append(`${err.message || err}\n`);
  render();
  leave(1);
});

child.on("close", finish);

// Repaint on a timer so elapsed time keeps moving while the child is silent.
const tick = setInterval(render, 250);

// ------------------------------------------------------------------- input

const onKey = (chunk) => {
  const ch = chunk.toString("latin1");

  if (state.done || state.failed || state.cancelled) {
    cleanup();
    leave(0);
  }

  if (ch === "\x1b" || ch === "\x03" || ch === "q") {
    state.cancelled = true;
    cleanup();
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Give the child a moment to unwind, then leave regardless.
    setTimeout(() => leave(0), 300);
  }
};

function cleanup() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.off("data", onKey);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
  process.stdout.write("\x1b[?25l");
}

render();
