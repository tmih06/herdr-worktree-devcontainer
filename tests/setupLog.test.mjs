import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failureRows, setupLog } from "../lib/wtdc/setupLog.mjs";

test("setup errors retain the feature failure before a long CLI stack trace", () => {
  const lines = [
    "Resolving Feature dependencies for './features/cli-tools'...",
    "Local file path parse error. Resolved path must be a child of the .devcontainer/ folder.",
    ...Array.from({ length: 20 }, (_, i) => `at async fn${i} (/cli.js:397:2321)`),
    "Node.js v24.18.0",
  ];
  assert.deepEqual(failureRows(lines, 6), lines.slice(0, 2));
});

test("the private setup log keeps complete output after the screen tail expires", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-log-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = setupLog("/repo/worktree", directory);
  const output = Array.from({ length: 250 }, (_, i) => `build line ${i}\n`).join("");
  log.append(Buffer.from(output));
  log.append("failure cause\n");
  assert.equal(fs.readFileSync(log.file, "utf8"), `${output}failure cause\n`);
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
});

test("the failed boot screen shows the cause and retains the complete CLI stack", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-boot-error-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "bin"));
  const output = [
    "Local file path parse error. Resolved path must be a child of the .devcontainer/ folder.",
    ...Array.from({ length: 20 }, (_, i) => `at async fn${i} (/cli.js:397:2321)`),
  ].join("\n");
  fs.writeFileSync(
    path.join(directory, "bin/wtdc.mjs"),
    `process.stderr.write(${JSON.stringify(output)}); process.exitCode=1;`,
  );
  const boot = fileURLToPath(new URL("../panes/boot.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [boot], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      HERDR_PLUGIN_ROOT: directory,
      HERDR_PLUGIN_STATE_DIR: path.join(directory, "state"),
      HERDR_PLUGIN_CONFIG_DIR: path.join(directory, "config"),
      WTDC_CHECKOUT: directory,
      WTDC_WORKSPACE: "",
      HERDR_WORKSPACE_ID: "",
      HERDR_PANE_ID: "",
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const frame = result.stdout.split("\x1b[H\x1b[2J").at(-1);
  assert.match(frame, /Local file path parse error/);
  assert.match(frame, /Setup failed/);
  assert.match(frame, /Full log:/);
  assert.doesNotMatch(frame, /at async fn/);
  const logs = path.join(directory, "state/logs");
  assert.equal(fs.readdirSync(logs).length, 1);
  assert.equal(fs.readFileSync(path.join(logs, fs.readdirSync(logs)[0]), "utf8"), output);
});
