#!/usr/bin/env node
// Blocking boot screen shown while a dev container is being provisioned.
//
// Opened zoomed over the new worktree's pane, so it holds the screen and the
// keyboard until the container is ready. The previous behaviour streamed
// `devcontainer up` into an ordinary tab, which meant the pane was easy to lose
// behind other tabs and the user had no way to tell a slow build from a hung
// one.
//
// The provisioner runs as a child process. Its stderr carries both ordinary
// output and tagged progress lines (see lib/wtdc/progress.mjs); this pane
// consumes the tags into the bar and keeps a tail of the rest, so a failure
// still shows the tool's own message.
//
// Keys:  Esc  cancel the build and close      (after the build) any key  close

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, isProgressLine, parseProgressLine } from '../lib/wtdc/progress.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || path.resolve(here, '..');

const checkout = process.env.WTDC_CHECKOUT || '';
const label = process.env.WTDC_LABEL || path.basename(checkout);
const workspace = process.env.WTDC_WORKSPACE || '';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', blue: '\x1b[34m',
};

if (!checkout) {
  process.stdout.write('dev container: no worktree path was supplied\n');
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
};

const byKey = Object.fromEntries(PHASES.map((p) => [p.key, p]));

/** Cumulative percent where a phase starts, so the bar never jumps backwards. */
function phaseStart(key) {
  let acc = 0;
  for (const p of PHASES) {
    if (p.key === key) return acc;
    acc += p.share;
  }
  return acc;
}

function elapsed() {
  return ((Date.now() - state.startedAt) / 1000).toFixed(0);
}

const BAR_WIDTH = 34;
const LOG_LINES = 6;

function bar(percent, indeterminate) {
  // The long phase animates rather than inventing a percentage: `devcontainer
  // up` reports nothing until it returns, so a number here would be a guess
  // dressed up as a measurement.
  const filled = indeterminate
    ? Math.floor(((Date.now() / 120) % (BAR_WIDTH + 8)))
    : Math.round((percent / 100) * BAR_WIDTH);
  const head = Math.min(filled, BAR_WIDTH);
  return `${C.cyan}${'█'.repeat(head)}${C.dim}${'░'.repeat(Math.max(0, BAR_WIDTH - head))}${C.reset}`;
}

function render() {
  const current = byKey[state.phase] || PHASES[0];
  const lines = [];

  lines.push('');
  lines.push(`  ${C.cyan}Setting up the dev container${C.reset}  ${C.dim}${label}${C.reset}`);
  lines.push(`  ${C.dim}${checkout}${C.reset}`);
  lines.push('');

  lines.push(`  ${bar(state.percent, current.indeterminate)}  ${Math.round(state.percent)}%  ${C.dim}[${elapsed()}s]${C.reset}`);
  lines.push('');
  lines.push(`  ${C.blue}›${C.reset} ${current.label}${current.indeterminate ? `${C.dim} (working)${C.reset}` : ''}`);
  lines.push('');

  // Phase checklist, so a long build shows that it is moving through stages
  // rather than sitting on one line.
  for (const p of PHASES) {
    const start = phaseStart(p.key) * 100;
    const end = (phaseStart(p.key) + p.share) * 100;
    const done = state.done || state.percent >= end;
    const active = !done && p.key === state.phase;
    const mark = done ? `${C.green}✔${C.reset}` : active ? `${C.cyan}▸${C.reset}` : `${C.dim}·${C.reset}`;
    lines.push(`   ${mark} ${done ? C.dim : active ? '' : C.dim}${p.label}${C.reset}`);
  }

  if (state.log.length) {
    lines.push('');
    lines.push(`  ${C.dim}── ${state.failed ? 'output' : 'detail'} ──${C.reset}`);
    for (const l of state.log.slice(-LOG_LINES)) {
      lines.push(`  ${state.failed ? C.red : C.dim}${l}${C.reset}`);
    }
  }

  lines.push('');
  if (state.failed) {
    lines.push(`  ${C.red}Setup failed.${C.reset} The worktree is untouched — fix the problem and`);
    lines.push(`  run ${C.dim}herdr plugin action invoke worktree-devcontainer.provision${C.reset} to retry.`);
  } else if (state.cancelled) {
    lines.push(`  ${C.yellow}Cancelled.${C.reset} No container was created.`);
  } else if (state.done) {
    lines.push(`  ${C.green}Ready.${C.reset} Every terminal you open in this worktree now runs`);
    lines.push(`  inside the container.`);
  }

  lines.push('');
  if (!state.done && !state.failed && !state.cancelled) {
    lines.push(`  ${C.dim}Esc to cancel${C.reset}`);
  } else {
    lines.push(`  ${C.dim}press any key to close${C.reset}`);
  }
  lines.push('');

  // Home + clear rather than clear+home: repainting from the top avoids
  // smearing when the previous frame was taller than the next one.
  process.stdout.write(`\x1b[H\x1b[2J${lines.join('\n')}\n`);
}

// ------------------------------------------------------------------- child

const bin = path.join(pluginRoot, 'bin', 'wtdc.mjs');
const child = spawn(
  process.execPath,
  [bin, 'provision', checkout, workspace, label],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WTDC_PROGRESS: '1' } },
);

/** Fold one chunk of child output into the log tail. Both streams, not just
 *  stderr: wtdc prints some early-exit messages ("disabled inside a dev
 *  container", "no worktree path was supplied") to stdout. */
function consume(stream) {
  let partial = '';
  stream.on('data', (chunk) => {
    partial += chunk.toString();
    const rows = partial.split('\n');
    partial = rows.pop() || '';
    for (const row of rows) {
      const line = row.replace(/\r$/, '');
      if (!line) continue;
      if (isProgressLine(line)) {
        const p = parseProgressLine(line);
        if (!p) continue;
        if (p.phase === 'done') {
          state.done = true;
          state.percent = 100;
          state.phase = 'finish';
        } else {
          state.phase = p.phase;
          state.percent = Math.max(state.percent, p.percent);
        }
      } else {
        // Strip the plugin's own leading indentation and colour so the tail
        // reads as one column.
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\s+/, '').trim();
        if (clean) state.log.push(clean);
      }
    }
    render();
  });
}

consume(child.stdout);
consume(child.stderr);

const finish = (code) => {
  clearInterval(tick);
  state.phase = 'finish';
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
    if (!process.stdin.isTTY) setTimeout(() => process.exit(code || 1), 3000);
    return;
  }

  // Success closes on its own: provision has just opened and focused the
  // container tab, so standing here would only cover the thing it made.
  setTimeout(() => {
    process.stdout.write('\x1b[?25h');
    process.exit(0);
  }, 400);
};

child.on('error', (err) => {
  state.failed = true;
  state.log.push(String(err.message || err));
  render();
  process.exit(1);
});

child.on('close', finish);

// Repaint on a timer so the elapsed counter and the indeterminate bar move even
// while the child is silent, which is most of a long build.
const tick = setInterval(render, 250);

// ------------------------------------------------------------------- input

const onKey = (chunk) => {
  const ch = chunk.toString('latin1');

  if (state.done || state.failed || state.cancelled) {
    cleanup();
    process.stdout.write('\x1b[?25h');
    process.exit(0);
  }

  if (ch === '\x1b' || ch === '\x03' || ch === 'q') {
    state.cancelled = true;
    cleanup();
    process.stdout.write('\x1b[?25h');
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    // Give the child a moment to unwind, then leave regardless.
    setTimeout(() => process.exit(0), 300);
  }
};

function cleanup() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.off('data', onKey);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.write('\x1b[?25l');
}

render();
