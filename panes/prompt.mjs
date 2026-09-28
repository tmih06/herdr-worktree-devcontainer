#!/usr/bin/env node
// Overlay shown right after Herdr creates a worktree.
//
// Plugins cannot add a widget to Herdr's own worktree dialog, so this draws the
// question instead. It runs as a transient overlay; closing it restores the
// previous focus and zoom.
//
// Keys:  y / Enter  yes        n / Esc / q  no        space  toggle the box

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './../lib/wtdc/config.mjs';
import { findConfig } from './../lib/wtdc/devcontainer.mjs';
import { herdr } from './../lib/wtdc/herdr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || path.resolve(here, '..');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const checkout = process.env.WTDC_CHECKOUT || '';
const workspaceId = process.env.WTDC_WORKSPACE || '';
const label = process.env.WTDC_LABEL || '';
const repo = process.env.WTDC_REPO || '';

if (!checkout) {
  process.stdout.write('dev container: no worktree path in the invocation context\n');
  process.exit(1);
}

const config = loadConfig();
const found = findConfig(checkout, config.WTDC_CONFIG_CANDIDATES);
const configRel = found
  ? path.relative(checkout, found)
  : `${C.yellow}none found${C.reset}`;

function render(toggle) {
  process.stdout.write(`\x1b[2J\x1b[H
${C.cyan}  Dev container${C.reset}

  Worktree   ${label}
             ${C.dim}${checkout}${C.reset}
  Config     ${configRel}
  Repo       ${C.dim}${repo || 'unknown'}${C.reset}

  Builds the image and opens a container-backed terminal in this worktree.
  Every terminal you open here then runs inside the container. First build
  is slow.

  ${C.green}[${toggle}]${C.reset} Create a dev container for this worktree

  ${C.dim}y/Enter yes    n/Esc/q no    space toggle${C.reset}

`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true for yes, false for no. */
function ask() {
  return new Promise((resolve) => {
    let toggle = ' ';
    let buffer = '';

    const finish = (answer) => {
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

const accepted = await ask();
if (!accepted) process.exit(0);

process.stdout.write(`starting dev container for ${label}\n\n`);

// Hand the slow work to the build pane, opened as a tab in this same workspace
// so the image build streams where the user can watch it.
const bin = path.join(pluginRoot, 'bin', 'wtdc.mjs');
herdr([
  'plugin', 'pane', 'open',
  '--plugin', process.env.HERDR_PLUGIN_ID || 'worktree-devcontainer',
  '--entrypoint', 'build',
  '--placement', 'tab',
  '--cwd', checkout,
  '--env', 'WTDC_MODE=provision',
  '--env', `WTDC_CHECKOUT=${checkout}`,
  '--env', `WTDC_LABEL=${label}`,
  '--env', `WTDC_WORKSPACE=${workspaceId}`,
  ...(workspaceId ? ['--workspace', workspaceId] : []),
  '--focus',
]);

await sleep(50);
process.exit(0);
