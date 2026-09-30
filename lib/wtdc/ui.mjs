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

/** Report the CLI's structured failure and stderr without an uncaught Node stack.
 * Devcontainer puts its lifecycle summary on stdout, so stderr alone loses the
 * command and phase that failed. Generic command failures keep both streams. */
export function dieCommand(err, hint) {
  let summary = null;
  let summaryLine = -1;
  const stdoutLines = (err.stdout || "").trim().split("\n");
  for (let i = stdoutLines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(stdoutLines[i]);
      if (parsed?.outcome === "error") {
        summary = parsed;
        summaryLine = i;
        break;
      }
    } catch {
      // Progress and lifecycle output can precede the final JSON summary.
    }
  }
  const parts = [
    summary?.description,
    summary?.message,
    err.stderr,
    stdoutLines.filter((_line, index) => index !== summaryLine).join("\n"),
  ].filter((value) => typeof value === "string" && value.trim());
  const detailText = parts.length
    ? parts.map((part) => part.trim()).join("\n")
    : err.message || "command failed";
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
