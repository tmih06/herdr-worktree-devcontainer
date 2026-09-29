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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { loadConfig } from './../lib/wtdc/config.mjs';
import { findConfig, planProvision } from './../lib/wtdc/devcontainer.mjs';
import { herdr, openPluginPane } from './../lib/wtdc/herdr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || path.resolve(here, '..');
const imageInfoBin = path.join(pluginRoot, 'lib', 'wtdc', 'imageInfo.mjs');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  reverse: '\x1b[7m',
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

// The plan is resolved synchronously because it is only file parsing and a git call —
// cheap, and it is what the checkbox line has to be about. The image's local and
// registry state is the part that can be slow, so it is filled in afterwards.
let found = findConfig(checkout, config.WTDC_CONFIG_CANDIDATES);
let configRel = found
  ? path.relative(checkout, found)
  : `${C.yellow}none found${C.reset}`;
let plan = null;
let image = null;

/** One line per fact, indented under its label, and never longer than it needs to be. */
const rows = [];
const row = (label, ...lines) => rows.push([label, lines.filter(Boolean)]);

// ---------------------------------------------------------------- focus model
//
// Two things can be acted on: the answer, and the image. Focus starts on the answer, so
// every key that has always worked here still works the instant the dialog opens — `y`,
// Enter, space. Reaching the image is a deliberate move up, and only then does a letter
// type into it. That ordering is the whole design: a dialog that swallowed `n` into a
// text field would be a dialog that could not be declined.
const FOCUS_ANSWER = 'answer';
const FOCUS_IMAGE = 'image';
let focus = FOCUS_ANSWER;

let imageBuf = '';      // what the field holds
let imageCaret = 0;     // where the caret is in it
let imageDirty = false; // it differs from what the config declares

/** The image that will actually be used, which is the field unless it was left alone. */
const effectiveImage = () => (imageDirty ? imageBuf.trim() : (plan && plan.image) || '');

// The image check costs a docker call and a registry round trip, so it waits for the typing
// to stop. A second of quiet is the difference between "the dialog reacted" and "the dialog
// is thrashing" — a lookup per keystroke would be a dozen container pulls behind a word.
const IMAGE_SETTLE_MS = 1000;
let imageCheckTimer = null;

/** Note an edit, and arrange for the image it now names to be described. */
function markEdited() {
  imageDirty = imageBuf !== ((plan && plan.image) || '');
  image = null;               // the description belonged to the old image
  if (imageCheckTimer) clearTimeout(imageCheckTimer);
  imageCheckTimer = setTimeout(() => {
    imageCheckTimer = null;
    refreshImageLater();
  }, IMAGE_SETTLE_MS);
  imageCheckTimer.unref?.();
}

/** Re-read the config, and reset the field to whatever it now says. Never throws. */
function replan() {
  // Hold on to what was typed. The config is watched so the dialog can follow an edit made
  // in another window, and that must not delete the answer being typed in this one — the
  // person watching the dialog is not the person editing the file.
  const typed = imageBuf;
  const wasDirty = imageDirty;

  found = findConfig(checkout, config.WTDC_CONFIG_CANDIDATES);
  configRel = found
    ? path.relative(checkout, found)
    : `${C.yellow}none found${C.reset}`;
  plan = null;
  if (found) {
    try {
      plan = planProvision(found, config, checkout);
    } catch (err) {
      // A config this cannot be parsed is not a reason to refuse the question; the setup
      // screen will report it properly, with the file and the reason.
      plan = { error: err.message };
    }
  }

  const declared = (plan && plan.image) || '';
  imageBuf = wasDirty ? typed : declared;
  imageCaret = imageBuf.length;
  imageDirty = imageBuf !== declared;
  image = null;
  if (imageDirty) markEdited();
  return plan;
}

replan();

function imageLines() {
  if (!image) return [`${C.dim}checking…${C.reset}`];
  // An image on this machine that this machine cannot run is not a smaller problem than a
  // pull, it is a build that will fail, and the failure arrives as a minified stack trace
  // minutes later. It is worth the one line it takes to say so while there is still a
  // choice to make.
  if (image.wrongPlatform) {
    return [`${C.yellow}on this machine as ${image.localPlatform}, which this `
      + `host (${image.hostPlatform}) cannot run${C.reset}`];
  }
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

/** The image field, with a caret in it while it has focus. */
function imageField() {
  if (focus !== FOCUS_IMAGE) return imageBuf || `${C.yellow}none declared${C.reset}`;
  const at = Math.max(0, Math.min(imageCaret, imageBuf.length));
  const caret = `${C.reverse} ${C.reset}`;
  return `${imageBuf.slice(0, at)}${caret}${imageBuf.slice(at)}`;
}

function render(toggle) {
  if (plan && !plan.error) {
    rows.length = 0;
    row('Worktree', label, `${C.dim}${checkout}${C.reset}`);
    row('Config', configRel, `${C.dim}repo ${repo || 'unknown'}${C.reset}`);

    // Where the image on screen came from. An edit in this dialog is the one source the
    // config file cannot show, so it is named rather than left to be inferred from a caret.
    const source = imageDirty
      ? `  ${C.yellow}edited in this dialog${C.reset}`
      : plan.imageSource === 'devcontainer.json'
        ? ''
        : `  ${C.dim}from ${plan.imageSource}${C.reset}`;
    row('Image', `${imageField()}${source}`, ...imageLines());

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

    // What the container will have of the host's. A bind mount is a host path made
    // available inside, which is worth seeing named rather than inferred, and a mount that
    // is *not* read-only means anything in the container can change a file of yours — the
    // container user has the same uid you do, so nothing else stops it.
    const mounts = [];
    if (plan.mounts.length) {
      for (const mount of plan.mounts) {
        const from = mount.source || mount.type || 'mount';
        // Writable is only worth flagging for a bind: that is a file of yours inside the
        // container. A named volume is writable and holds nothing of yours.
        const risky = !mount.readonly && (mount.type === 'bind' || !mount.type);
        const how = mount.readonly
          ? `${C.dim}read-only${C.reset}`
          : risky
            ? `${C.yellow}writable from inside${C.reset}`
            : `${C.dim}writable${C.reset}`;
        mounts.push(`${C.dim}${from}${C.reset} → ${mount.target || '?'}  ${how}`);
      }
    } else {
      mounts.push(`${C.dim}none${C.reset}`);
    }
    row('Mounts', ...mounts);

    // What answering yes costs. The uid copy counts: it is a build the user did not ask
    // for, it happens on every provision whose image user is not their own uid, and a line
    // that says "a docker run" and then spends half a minute building an image is not a
    // description of anything.
    const bits = [];
    if (plan.buildsImage) bits.push(`${C.yellow}builds an image for this worktree (~25s+)${C.reset}`);
    else bits.push(`${C.green}no image build from features${C.reset} — a docker run`);
    if (plan.uidRemap === 'differs') {
      bits.push(`${C.yellow}and a uid-matched copy of the image${C.reset} ${C.dim}(~300 MB, tens of seconds)${C.reset}`);
    } else if (plan.uidRemap === 'unknown') {
      bits.push(`${C.dim}and a uid-matched copy if the image's user is not your uid${C.reset}`);
    }
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

  // The answer is a focusable item too, and it is where focus starts — so the keys that
  // have always answered this question still answer it without a move.
  const pointer = (on) => (on ? `${C.cyan}❯${C.reset}` : ' ');
  const answerLine = `${pointer(focus === FOCUS_ANSWER)} ${C.green}[${toggle}]${C.reset} `
    + 'Create a dev container for this worktree';

  const keys = focus === FOCUS_IMAGE
    ? `${C.dim}type to edit    ⏎ done    esc revert    ↑↓ move${C.reset}`
    : `${C.dim}y/⏎ yes    n/esc/q no    space toggle    ↑↓ to the image${C.reset}`;

  process.stdout.write(`\x1b[2J\x1b[H
${C.cyan}  Dev container${C.reset}

${body}

  ${answerLine}

  Opens a container-backed terminal in this worktree. Every terminal you open
  here then runs inside the container.

  ${keys}

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
      clearTimeout(imageCheckTimer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      resolve(answer);
    };

    /** Up, down, left, right, home, end. The whole vocabulary of the two fields. */
    function handleEscape(seq) {
      const last = seq[seq.length - 1];
      if (last === 'A' || last === 'B') {                 // up / down
        focus = focus === FOCUS_ANSWER ? FOCUS_IMAGE : FOCUS_ANSWER;
        if (focus === FOCUS_IMAGE) refreshImageLater();
        render(toggle);
        return true;
      }
      if (focus !== FOCUS_IMAGE) return false;
      if (last === 'C' && imageCaret < imageBuf.length) imageCaret += 1;   // right
      if (last === 'D' && imageCaret > 0) imageCaret -= 1;                  // left
      if (last === 'H') imageCaret = 0;                                     // home
      if (last === 'F') imageCaret = imageBuf.length;                       // end
      render(toggle);
      return true;
    }

    /** Returns true when the key ended the question. */
    function handleKey(ch) {
      if (ch === '\t') {                       // tab moves like the arrows do
        focus = focus === FOCUS_ANSWER ? FOCUS_IMAGE : FOCUS_ANSWER;
        if (focus === FOCUS_IMAGE) refreshImageLater();
        return false;
      }

      if (focus === FOCUS_IMAGE) {
        // In the field, a letter is a letter. `y` and `n` are ordinary characters
        // here, which is the only way an image reference can be typed at all.
        if (ch === '\r' || ch === '\n') { focus = FOCUS_ANSWER; render(toggle); return false; }
        if (ch === '\x7f' || ch === '\b') {
          if (imageCaret > 0) {
            imageBuf = imageBuf.slice(0, imageCaret - 1) + imageBuf.slice(imageCaret);
            imageCaret -= 1;
          }
        } else if (ch === '\x15') {                          // ctrl-u: clear the field
          imageBuf = '';
          imageCaret = 0;
        } else if (ch >= ' ') {
          imageBuf = imageBuf.slice(0, imageCaret) + ch + imageBuf.slice(imageCaret);
          imageCaret += 1;
        } else {
          return false;
        }
        markEdited();
        render(toggle);
        return false;
      }

      if (ch === '\r' || ch === '\n') return finish(true);
      if (ch === 'y' || ch === 'Y') return finish(true);
      if (ch === 'n' || ch === 'N' || ch === 'q' || ch === 'Q') return finish(false);
      if (ch === ' ') toggle = toggle === ' ' ? 'x' : ' ';
      return false;
    }

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
            if (!handleEscape(match[0])) return;
            continue;
          }
          // ESC with nothing after it: a real Esc keypress, bounded by the
          // fact that a terminal sends a sequence in one burst.
          buffer = buffer.slice(1);
          // On the image field, Esc puts back what the config said — a way to
          // try something and change your mind without losing the question.
          if (focus === FOCUS_IMAGE && imageDirty) {
            imageBuf = (plan && plan.image) || '';
            imageCaret = imageBuf.length;
            imageDirty = false;
            image = null;
            refreshImageLater();
            render(toggle);
            return;
          }
          finish(false);
          return;
        }

        buffer = buffer.slice(1);
        if (handleKey(ch)) return;
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

/**
 * Ask for the image's state in a process of its own.
 *
 * The lookup is synchronous child processes, one of which waits on a registry. Run here it
 * would be seconds during which a keypress is not read and the config watcher does not
 * fire — a question that stops answering the moment you look at the network. Out of
 * process, the prompt stays live and the answer arrives whenever it arrives.
 */
function refreshImageLater() {
  const ref = effectiveImage();
  if (!ref) {
    image = null;
    return;
  }
  const child = spawn(process.execPath, [imageInfoBin, ref], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.on('error', () => { /* "checking…" is a better answer than a wrong one */ });
  child.on('close', () => {
    if (answered) return;
    let described = null;
    try {
      described = JSON.parse(out);
    } catch { /* left as "checking…" */ }
    if (!described) return;
    // Against the image the field holds *now*, not the one this lookup was started for.
    // A slow answer for the previous image lands after the user has typed a new one, and
    // honouring it would describe an image that is no longer on screen.
    if (described.ref !== effectiveImage()) return;
    if (described.state === image?.state && described.size === image?.size) return;
    image = described;
    render(toggle);
  });
  // A lookup nobody is waiting for should not outlive the question.
  child.unref();
}

refreshImageLater();

/**
 * Watch the config and re-plan when it changes.
 *
 * The question is asked while the user is quite likely editing the very file it
 * describes — trying an image, adding a feature — and a dialog that keeps quoting a plan
 * the user has already replaced is not a stale frame, it is a wrong answer. Editing
 * devcontainer.json in another window and saving is the ordinary way this happens, and
 * there is no keypress to hang the refresh on.
 *
 * Statting one file twice a second costs nothing. The image lookup does not run on
 * every tick: only when the image it describes is actually a different one, since that
 * half needs docker and the network.
 */
const watched = new Map();
const stampOf = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
};
const remember = () => {
  for (const file of config.WTDC_CONFIG_CANDIDATES.trim().split(/\s+/).filter(Boolean)) {
    watched.set(path.resolve(checkout, file), stampOf(path.resolve(checkout, file)));
  }
};
remember();

const watcher = setInterval(() => {
  if (answered) return;
  let changed = false;
  for (const [file, was] of watched) {
    const now = stampOf(file);
    if (now !== was) {
      watched.set(file, now);
      changed = true;
    }
  }
  // A config appearing where there was none counts too, so `findConfig` is re-run rather
  // than only the file that was already there.
  if (!found) {
    for (const file of watched.keys()) {
      if (stampOf(file)) changed = true;
    }
  }
  if (!changed) return;

  const before = plan && plan.image;
  replan();
  if (plan && plan.image !== before) {
    image = null;      // the description now belongs to a different image
    refreshImageLater();
  }
  render(toggle);
}, 750);
watcher.unref();

const accepted = await answer;
clearInterval(watcher);
if (!accepted) process.exit(0);

// An image typed into the field is what gets built, so it has to travel with the build.
// Environment only, and only when the field was actually changed: left alone, the config's
// own image is used, which is the whole point of the field being a placeholder.
if (imageDirty && imageBuf.trim()) {
  process.env.WTDC_OVERRIDE_IMAGE = imageBuf.trim();
}

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
