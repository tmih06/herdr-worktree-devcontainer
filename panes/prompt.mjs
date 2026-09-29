#!/usr/bin/env node
// Overlay shown right after Herdr creates a worktree.
//
// Plugins cannot add a widget to Herdr's own worktree dialog, so this draws the
// question instead. It runs as a transient overlay; closing it restores the
// previous focus and zoom.
//
// It shows what answering yes would actually cost, because that is not knowable
// from the config file: the image may or may not be on this machine already, the
// registry may have a newer one, and features decide whether this is a `docker run`
// or an image build. The plan comes from the same function provisioning uses, so
// what is described here is what runs. The image's local and registry state needs
// docker and the network, so it is gathered after the first frame and the line
// fills in when it arrives — the question is never held hostage to a registry.
//
// Keys:  y / Enter  yes        n / Esc / q  no        space  toggle the box

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { loadConfig } from './../lib/wtdc/config.mjs';
import { findConfig, planProvision } from './../lib/wtdc/devcontainer.mjs';
import { describeImage } from './../lib/wtdc/imageInfo.mjs';
import { herdr, openPluginPane } from './../lib/wtdc/herdr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || path.resolve(here, '..');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const checkout = process.env.WTDC_CHECKOUT || '';
const workspaceId = process.env.WTDC_WORKSPACE || '';
const label = process.env.WTDC_LABEL || '';
const repo = process.env.WTDC_REPO || '';
// The worktree's own pane, identified by the hook before this overlay existed.
const targetPane = process.env.WTDC_TARGET_PANE || '';

if (!checkout) {
  process.stdout.write('dev container: no worktree path in the invocation context\n');
  process.exit(1);
}

const config = loadConfig();
const found = findConfig(checkout, config.WTDC_CONFIG_CANDIDATES);
const configRel = found
  ? path.relative(checkout, found)
  : `${C.yellow}none found${C.reset}`;

// The plan is resolved synchronously because it is only file parsing and a git call —
// cheap, and it is what the checkbox line has to be about. The image's local and
// registry state is the part that can be slow, so it is filled in afterwards.
let plan = null;
if (found) {
  try {
    plan = planProvision(found, config, checkout);
  } catch (err) {
    // A config this cannot be parsed is not a reason to refuse the question; the setup
    // screen will report it properly, with the file and the reason.
    plan = { error: err.message };
  }
}
let image = null;

/** One line per fact, indented under its label, and never longer than it needs to be. */
const rows = [];
const row = (label, ...lines) => rows.push([label, lines.filter(Boolean)]);

function imageLines() {
  if (!image) return [`${C.dim}checking…${C.reset}`];
  const size = image.size ? `${C.dim}${image.size}${C.reset}` : '';
  switch (image.state) {
    case 'up-to-date':
      return [`${C.dim}already pulled, same as published${C.reset}${size ? `  ${size}` : ''}`];
    case 'update-available':
      return [`${C.yellow}newer image published — will be pulled${C.reset}${size ? `  ${size}` : ''}`];
    case 'absent':
      return [`${C.yellow}not on this machine — will be pulled${C.reset}${size ? `  ${size}` : ''}`];
    default:
      return [`${C.dim}local state unknown${C.reset}`];
  }
}

function render(toggle) {
  if (plan && !plan.error) {
    rows.length = 0;
    row('Worktree', label, `${C.dim}${checkout}${C.reset}`);
    row('Config', configRel, `${C.dim}repo ${repo || 'unknown'}${C.reset}`);

    const source = plan.imageSource === 'devcontainer.json'
      ? ''
      : `  ${C.dim}from ${plan.imageSource}${C.reset}`;
    row('Image', `${plan.image || `${C.yellow}none declared${C.reset}`}${source}`, ...imageLines());

    const features = [];
    if (plan.keptFeatures.length) {
      for (const f of plan.keptFeatures) features.push(`${C.dim}${f}${C.reset}`);
    } else {
      features.push(`${C.dim}none${C.reset}`);
    }
    if (plan.droppedFeatures.length) {
      features.push(`${C.yellow}not applied: ${plan.droppedFeatures.join(', ')}${C.reset}`);
    }
    row('Features', ...features);

    const bits = [];
    if (plan.buildsImage) bits.push(`${C.yellow}builds an image for this worktree (~25s+)${C.reset}`);
    else bits.push(`${C.green}no image build${C.reset} — a docker run`);
    if (plan.remoteUser) bits.push(`${C.dim}user ${plan.remoteUser}${C.reset}`);
    if (plan.hostname) bits.push(`${C.dim}hostname ${plan.hostname}${C.reset}`);
    row('Setup', ...bits);
  } else {
    rows.length = 0;
    row('Worktree', label, `${C.dim}${checkout}${C.reset}`);
    row('Config', configRel, `${C.dim}repo ${repo || 'unknown'}${C.reset}`);
    if (plan && plan.error) row('', `${C.yellow}cannot read it: ${plan.error}${C.reset}`);
  }

  const width = Math.max(...rows.map(([l]) => l.length));
  const body = rows.map(([l, lines]) => {
    const head = l ? `  ${l.padEnd(width)}  ` : ' '.repeat(width + 4);
    return head + lines[0] + lines.slice(1).map((x) => `\n${' '.repeat(width + 4)}${x}`).join('');
  }).join('\n');

  process.stdout.write(`\x1b[2J\x1b[H
${C.cyan}  Dev container${C.reset}

${body}

  Opens a container-backed terminal in this worktree. Every terminal you open
  here then runs inside the container.

  ${C.green}[${toggle}]${C.reset} Create a dev container for this worktree

  ${C.dim}y/Enter yes    n/Esc/q no    space toggle${C.reset}

`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Module scope, because the image lookup repaints after the first frame and has to
// redraw the box in whatever state the user has it in by then.
let toggle = ' ';
let answered = false;

/** Resolves true for yes, false for no. */
function ask() {
  return new Promise((resolve) => {
    let buffer = '';

    const finish = (answer) => {
      answered = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      resolve(answer);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l');

    const onData = (chunk) => {
      buffer += chunk.toString('latin1');

      // An arrow key arrives as one ESC [ A burst. Handling only the first byte
      // would leave a bare ESC, which reads as "press Esc" and silently
      // declines the prompt — the bug this prompt's key handling exists to
      // avoid. So consume the whole escape sequence before deciding.
      while (buffer.length > 0) {
        const ch = buffer[0];

        if (ch === '\x1b') {
          const match = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(buffer);
          if (match) {
            buffer = buffer.slice(match[0].length);
            continue;
          }
          // ESC with nothing after it: a real Esc keypress, bounded by the
          // fact that a terminal sends a sequence in one burst.
          buffer = buffer.slice(1);
          finish(false);
          return;
        }

        buffer = buffer.slice(1);
        if (ch === '\r' || ch === '\n') return finish(true);
        if (ch === 'y' || ch === 'Y') return finish(true);
        if (ch === 'n' || ch === 'N' || ch === 'q' || ch === 'Q') return finish(false);
        if (ch === ' ') {
          toggle = toggle === ' ' ? 'x' : ' ';
        }
        // Anything else is ignored, so a stray key never dismisses the prompt.
        render(toggle);
      }
    };

    process.stdin.on('data', onData);
    render(toggle);

    // Do not block a hook on a question nobody answers.
    setTimeout(() => {
      process.stdin.off('data', onData);
      finish(false);
    }, 600_000).unref();
  });
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stdout.write(`dev container: no interactive terminal, skipping ${label}\n`);
  process.exit(1);
}

// Ask first, look second. The image check needs docker and possibly the network, and a
// question that stalls on a registry is a question the user has already answered by
// guessing. It runs after the first frame and repaints in place when it lands; if the key
// has already been pressed this is simply a wasted lookup.
const answer = ask();

if (plan && plan.image) {
  setTimeout(() => {
    let described = null;
    try {
      described = describeImage(plan.image);
    } catch { /* left as "checking…" rather than a wrong answer */ }
    if (described) {
      image = described;
      if (!answered) render(toggle);
    }
  }, 0).unref();
}

const accepted = await answer;
if (!accepted) process.exit(0);

process.stdout.write(`starting dev container for ${label}\n\n`);

// The boot pane cannot be opened from in here. A pane opened with no target
// lands on the *active* pane, and right now that is this overlay — so the setup
// screen would be stacked on the question and then die with it. That is exactly
// what "I pressed yes and nothing happened" was: the boot pane opened, and the
// prompt exiting took it down.
//
// So hand off to a detached process and exit. It waits for this overlay to
// disappear, then focuses the worktree's workspace and opens the boot pane on
// the real pane underneath.
const bin = path.join(pluginRoot, 'bin', 'wtdc.mjs');
const launcher = spawn(
  process.execPath,
  [bin, 'boot-launch', checkout, workspaceId, label, targetPane],
  { detached: true, stdio: 'ignore' },
);
launcher.unref();

process.exit(0);
