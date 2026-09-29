#!/usr/bin/env node
// Streams a provision or teardown run in a normal tab.
//
// The work can take minutes, so this stays attached to the tab and prints the
// outcome rather than returning immediately and leaving the user guessing.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.HERDR_PLUGIN_ROOT || path.resolve(here, "..");

const mode = process.env.WTDC_MODE || "provision";
const checkout = process.env.WTDC_CHECKOUT || "";
const label = process.env.WTDC_LABEL || "";
const workspace = process.env.WTDC_WORKSPACE || "";

process.stdout.write("\x1b[2J\x1b[H");
process.stdout.write(`dev container: ${mode} for ${label || path.basename(checkout)}\n\n`);

if (!checkout) {
  process.stdout.write("error: no worktree path was supplied\n");
  process.exit(1);
}

const bin = path.join(pluginRoot, "bin", "wtdc.mjs");
// teardown's second argument is a force flag, not a workspace, so keep the
// argv shapes distinct rather than passing one positional shape to both.
const args =
  mode === "teardown"
    ? [bin, "teardown", checkout]
    : [bin, "provision", checkout, workspace, label];

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
const rc = result.status === null ? 1 : result.status;

process.stdout.write(`\n${"=".repeat(60)}\n`);
process.stdout.write(rc === 0 ? "done\n" : `failed (exit ${rc})\n`);
process.exit(rc);
