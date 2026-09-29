// Terminal output and Herdr notifications.
//
// The step/ok/warn shape is deliberate: provisioning is slow enough that the
// user needs to see which stage they are in, and the elapsed time on each line
// is the only progress signal during an image build.

import { HERDR_BIN, elapsed } from "./context.mjs";
import { tryRun } from "./run.mjs";

const C = {
  reset: "[0m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  cyan: "[36m",
};

const isTTY = process.stderr.isTTY;
const paint = (code, text) => (isTTY ? `${code}${text}${C.reset}` : text);

export const step = (msg) =>
  process.stderr.write(`\n${paint(C.blue, `==> [${elapsed().toFixed(0)}s]`)} ${msg}\n`);
export const ok = (msg) => process.stderr.write(`  ${paint(C.green, "ok:")} ${msg}\n`);
export const info = (msg) => process.stderr.write(`  ${msg}\n`);
export const detail = (msg) => process.stderr.write(`  ${paint(C.dim, msg)}\n`);
export const warn = (msg) => process.stderr.write(`  ${paint(C.yellow, "warn:")} ${msg}\n`);

/** Abort with a message. Always exits; call sites do not need to return. */
export function die(msg) {
  process.stderr.write(`  ${paint(C.red, "error:")} ${msg}\n`);
  process.exit(1);
}

/** Raise a command failure with the tool's own stderr, which is more useful. */
export function dieCommand(err, hint) {
  const detailText = (err.stderr || err.message || "").trim();
  die(`${detailText}${hint ? `\n   ${hint}` : ""}`);
}

/**
 * Raise a Herdr notification.
 *
 * Sound matters as much as the toast: a first image build is minutes of
 * silence, and a different sound for "needs you" versus "finished" is how the
 * user knows to come back.
 */
export function notify(title, body, sound = "request") {
  if (process.env.WTDC_NOTIFY === "0") return;
  tryRun(HERDR_BIN, ["notification", "show", title, "--body", body, "--sound", sound], {
    stdio: "ignore",
  });
}

export { C as colors };
