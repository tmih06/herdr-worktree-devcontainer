import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const boot = path.resolve(import.meta.dirname, "../panes/boot.mjs");

function handoff(t, preserve) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-boot-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(dir, "calls");
  const state = path.join(dir, "state.json");
  fs.writeFileSync(
    state,
    JSON.stringify({
      version: 1,
      entries: {
        [dir]: { container_id: "fixture-container", container_workspace: "/workspace" },
      },
    }),
  );
  fs.writeFileSync(
    path.join(bin, "wtdc.mjs"),
    'process.stderr.write("WTDC_PROGRESS\\tdone\\t100\\tready\\n");',
  );
  fs.writeFileSync(
    path.join(bin, "herdr"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n");
console.log("{}");
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "ps") console.log("fixture-container");
if (args[0] === "exec") {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["container-shell"])+"\\n");
  console.log("CONTAINER SHELL READY");
}
`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, [boot], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HERDR_BIN_PATH: path.join(bin, "herdr"),
      HERDR_PLUGIN_ROOT: dir,
      HERDR_PLUGIN_STATE_DIR: path.join(dir, "logs"),
      HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
      HERDR_PANE_ID: "w-test:p-boot",
      HERDR_WORKSPACE_ID: "w-test",
      WTDC_WORKSPACE: "w-test",
      WTDC_STATE_FILE: state,
      WTDC_CHECKOUT: dir,
      WTDC_TARGET_PANE: "w-test:p-host",
      WTDC_OPEN_CONTAINER_PANE: "1",
      WTDC_PRESERVE_PANES: preserve ? "1" : "0",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONTAINER SHELL READY/);
  return fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
}

test("successful setup clears its setup label and zoom before entering the container", (t) => {
  const calls = handoff(t, false);
  assert.deepEqual(calls, [
    ["pane", "close", "w-test:p-host"],
    ["pane", "rename", "w-test:p-boot", "--clear"],
    ["pane", "zoom", "w-test:p-boot", "--off"],
    ["container-shell"],
  ]);
});

test("reopen hands the setup pane over without closing existing panes", (t) => {
  const calls = handoff(t, true);
  assert.deepEqual(calls, [
    ["pane", "rename", "w-test:p-boot", "--clear"],
    ["pane", "zoom", "w-test:p-boot", "--off"],
    ["container-shell"],
  ]);
});
