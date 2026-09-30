import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

// Model actual container existence, including a daemon outage and individual
// removal failures. The checkout is already absent when the removal hook runs.
function fixture(t, { tracked = true, containers = ["tracked"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, "deleted-worktree");
  const merged = path.join(dir, "merged", "devcontainer.json");
  const stateFile = path.join(dir, "state.json");
  const dockerFile = path.join(dir, "containers.json");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.dirname(merged));
  fs.writeFileSync(merged, "{}");
  fs.writeFileSync(dockerFile, JSON.stringify(containers));
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      entries: tracked ? { [checkout]: { container_id: "tracked", merged_config: merged } } : {},
    }),
  );
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = process.env.CLEANUP_DOCKER_FILE;
const containers = JSON.parse(fs.readFileSync(file, "utf8"));
fs.appendFileSync(file + ".calls", JSON.stringify(args) + "\\n");
if (args[0] === "--version") process.exit(0);
if (process.env.CLEANUP_DAEMON_FAIL === "1") {
  console.error("Cannot connect to the Docker daemon");
  process.exit(1);
}
if (args[0] === "ps") {
  const filter = args[args.indexOf("--filter") + 1] || "";
  console.log(containers.filter(id => filter.startsWith("id=") ? filter === "id=" + id : id !== process.env.CLEANUP_UNLABELLED_ID).join("\\n"));
} else if (args[0] === "rm") {
  const id = args.at(-1);
  if (process.env.CLEANUP_CRASH_ON_RM === "1") {
    process.kill(process.ppid, "SIGKILL");
    process.exit(1);
  }
  if (id === process.env.CLEANUP_RACE_ID) {
    fs.writeFileSync(file, JSON.stringify(containers.filter(c => c !== id)));
    console.error("No such container: " + id);
    process.exit(1);
  }
  if (id === process.env.CLEANUP_RM_FAIL) {
    console.error("removal failed for " + id);
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify(containers.filter(c => c !== id)));
} else if (args[0] === "inspect") {
  console.log("true");
}
`,
    { mode: 0o755 },
  );
  for (const name of ["devcontainer", "herdr"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HERDR_PLUGIN_ROOT: ROOT,
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: dir,
    HERDR_BIN_PATH: path.join(bin, "herdr"),
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { worktree: { path: checkout } } }),
    WTDC_STATE_FILE: stateFile,
    WTDC_ENABLED: "1",
    WTDC_KEEP_CONTAINER: "0",
    WTDC_IN_CONTAINER: "0",
    WTDC_IN_CONTAINER_MARKER: path.join(dir, "no-container-marker"),
    WTDC_NOTIFY: "0",
    CLEANUP_DOCKER_FILE: dockerFile,
  };
  return {
    checkout,
    merged,
    entry: () => JSON.parse(fs.readFileSync(stateFile, "utf8")).entries[checkout],
    containers: () => JSON.parse(fs.readFileSync(dockerFile, "utf8")),
    run: (args, extra = {}) =>
      spawnSync(process.execPath, [path.join(ROOT, "bin/wtdc.mjs"), ...args], {
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}

test("failed removal keeps recovery state and config after checkout deletion", (t) => {
  const f = fixture(t);
  const res = f.run(["hook-removed"], { CLEANUP_RM_FAIL: "tracked" });
  assert.deepEqual(f.containers(), ["tracked"]);
  assert.ok(f.entry(), "the living container must remain tracked for retry");
  assert.equal(fs.existsSync(f.merged), true, "cleanup must retain its merged config");
  assert.notEqual(res.status, 0, "failed cleanup must not report success");
  assert.doesNotMatch(res.stderr, /ok: torn down/);
});

test("Docker query failure cannot be mistaken for an absent container", (t) => {
  const f = fixture(t);
  const res = f.run(["hook-removed"], { CLEANUP_DAEMON_FAIL: "1" });
  assert.ok(f.entry(), "daemon failure must retain recovery state");
  assert.equal(fs.existsSync(f.merged), true);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Docker daemon/);
});

test("startup retries a failed removal after the daemon recovers", (t) => {
  const f = fixture(t);
  f.run(["hook-removed"], { CLEANUP_RM_FAIL: "tracked" });
  const res = f.run(["startup"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), [], "startup must clean the removed worktree's container");
  assert.equal(f.entry(), undefined);
  assert.equal(fs.existsSync(f.merged), false);
});

test("startup recovers when the removal hook never ran", (t) => {
  const f = fixture(t);
  const res = f.run(["startup"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
  assert.equal(f.entry(), undefined);
});

test("startup recovers after the hook is killed midway through cleanup", (t) => {
  const f = fixture(t);
  const killed = f.run(["hook-removed"], { CLEANUP_CRASH_ON_RM: "1" });
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(f.entry().cleanup_pending, true, "intent must be saved before removal");
  assert.deepEqual(f.containers(), ["tracked"]);
  assert.equal(fs.existsSync(f.merged), true);
  const res = f.run(["startup"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
  assert.equal(f.entry(), undefined);
});

test("startup resumes explicit teardown even when the checkout still exists", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.checkout);
  const failed = f.run(["teardown", f.checkout], { CLEANUP_RM_FAIL: "tracked" });
  assert.notEqual(failed.status, 0);
  const res = f.run(["startup"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
  assert.equal(fs.existsSync(f.checkout), true);
});

test("a failed orphan sweep is recorded and can be retried on startup", (t) => {
  const f = fixture(t, { tracked: false, containers: ["orphan"] });
  const failed = f.run(["hook-removed"], { CLEANUP_RM_FAIL: "orphan" });
  assert.notEqual(failed.status, 0);
  assert.ok(f.entry(), "an untracked orphan needs a durable retry entry");
  const res = f.run(["startup"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
  assert.equal(f.entry(), undefined);
});

test("one removal failure does not prevent attempts to remove other containers", (t) => {
  const f = fixture(t, { containers: ["tracked", "sidecar"] });
  const res = f.run(["hook-removed"], { CLEANUP_RM_FAIL: "tracked" });
  assert.notEqual(res.status, 0);
  assert.deepEqual(f.containers(), ["tracked"]);
  assert.ok(f.entry());
});

test("startup honors deliberately kept containers", (t) => {
  const f = fixture(t);
  const res = f.run(["startup"], { WTDC_KEEP_CONTAINER: "1" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), ["tracked"]);
});

test("teardown can retry orphan cleanup directly by the deleted checkout path", (t) => {
  const f = fixture(t, { tracked: false, containers: ["orphan"] });
  const res = f.run(["teardown", f.checkout, "--force"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
});

test("cleanup still removes the saved container if its worktree label is missing", (t) => {
  const f = fixture(t);
  const res = f.run(["hook-removed"], { CLEANUP_UNLABELLED_ID: "tracked" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
  assert.equal(f.entry(), undefined);
});

test("a concurrently removed container is successful cleanup and remains retryable", (t) => {
  const f = fixture(t);
  const res = f.run(["hook-removed"], { CLEANUP_RACE_ID: "tracked" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.containers(), []);
  assert.equal(f.entry(), undefined);
  const again = f.run(["hook-removed"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(f.entry(), undefined);
});
