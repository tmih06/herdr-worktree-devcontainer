import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installNativeCleanup, realGit } from "../lib/wtdc/nativeCleanup.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REAL_GIT = realGit();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-native-test-"));
  const repo = path.join(dir, "repo");
  const checkout = path.join(dir, "checkout with spaces");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const git = (...args) => {
    const result = spawnSync(REAL_GIT, ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "blocked"));
  fs.writeFileSync(path.join(repo, "blocked", "tracked"), "fixture");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
  git("worktree", "add", "-q", "-b", "test", checkout);
  const stateFile = path.join(dir, "state.json");
  const dockerFile = path.join(dir, "docker.json");
  const volumes = ["wtdc-dind-docker-test", "wtdc-dind-containerd-test"];
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      entries: { [checkout]: { container_id: "outer", cleanup_volumes: volumes } },
    }),
  );
  fs.writeFileSync(dockerFile, JSON.stringify({ containers: ["outer"], volumes }));
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = process.env.NATIVE_DOCKER_FILE;
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
if (args[0] === "ps") console.log(doc.containers.join("\\n"));
else if (args[0] === "inspect") console.log(JSON.stringify(doc.volumes.map(Name => ({ Type: "volume", Name, Destination: Name.includes("containerd") ? "/var/lib/containerd" : "/var/lib/docker" }))));
else if (args[0] === "rm") {
  if (!fs.existsSync(${JSON.stringify(path.join(checkout, ".git"))})) { console.error("Git was deleted before Docker"); process.exit(1); }
  if (process.env.NATIVE_FAIL === "1") { console.error("Docker removal failed"); process.exit(1); }
  doc.containers = [];
} else if (args[0] === "volume" && args[1] === "ls") console.log(doc.volumes.join("\\n"));
else if (args[0] === "volume" && args[1] === "rm") doc.volumes = doc.volumes.filter(v => v !== args.at(-1));
fs.writeFileSync(file, JSON.stringify(doc));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "herdr"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    WTDC_REAL_GIT: REAL_GIT,
    HERDR_PLUGIN_ROOT: ROOT,
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: dir,
    WTDC_STATE_FILE: stateFile,
    WTDC_ENABLED: "1",
    WTDC_KEEP_CONTAINER: "0",
    WTDC_IN_CONTAINER: "0",
    HERDR_BIN_PATH: path.join(bin, "herdr"),
    WTDC_NOTIFY: "0",
    NATIVE_DOCKER_FILE: dockerFile,
  };
  t.after(() => {
    if (fs.existsSync(path.join(checkout, "blocked")))
      fs.chmodSync(path.join(checkout, "blocked"), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    checkout,
    repo,
    env,
    resources: () => JSON.parse(fs.readFileSync(dockerFile, "utf8")),
    run: (args = ["-C", repo, "worktree", "remove", checkout], extra = {}) =>
      spawnSync(process.execPath, [path.join(ROOT, "bin/git.mjs"), ...args], {
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 10000,
      }),
  };
}

test("native Git removal cleans the DinD container and volumes before deleting Git", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.resources(), { containers: [], volumes: [] });
  assert.equal(fs.existsSync(f.checkout), false);
});

test("native removal keeps Git intact when Docker cleanup fails", (t) => {
  const f = fixture(t);
  const result = f.run(undefined, { NATIVE_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(f.checkout, ".git")), true);
  assert.match(result.stderr, /Docker removal failed/);
});

test("native removal rejects dirty worktrees without touching Docker", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "uncommitted"), "keep");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.resources().containers, ["outer"]);
  assert.equal(fs.existsSync(path.join(f.checkout, "uncommitted")), true);
});

test("native removal completes an owner-readonly leftover after Git unregisters it", (t) => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.checkout, "blocked"), 0o555);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.resources(), { containers: [], volumes: [] });
  assert.equal(fs.existsSync(f.checkout), false);
});

test("other Git commands pass through unchanged", (t) => {
  const f = fixture(t);
  const result = f.run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, spawnSync(REAL_GIT, ["--version"], { encoding: "utf8" }).stdout);
  assert.deepEqual(f.resources().containers, ["outer"]);
});

test("native force removal preserves Git's explicit force semantics", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "uncommitted"), "delete by explicit request");
  const result = f.run([
    "-c",
    "safe.directory=*",
    "-C",
    f.repo,
    "worktree",
    "remove",
    "--force",
    "--",
    f.checkout,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.checkout), false);
  assert.deepEqual(f.resources().containers, []);
});

test("installer refuses an unrelated Git executable", (t) => {
  const f = fixture(t);
  const binDir = path.join(f.repo, "bin");
  fs.mkdirSync(binDir);
  const existing = path.join(binDir, "git");
  fs.writeFileSync(existing, "original", { mode: 0o755 });
  assert.throws(() => installNativeCleanup({ binDir, gitBin: REAL_GIT }), /refusing to replace/);
  assert.equal(fs.readFileSync(existing, "utf8"), "original");
});

test("installed launcher delegates normal Git commands and can be installed twice", (t) => {
  const f = fixture(t);
  const binDir = path.join(f.repo, "bin");
  const file = installNativeCleanup({ binDir, gitBin: REAL_GIT });
  assert.equal(installNativeCleanup({ binDir, gitBin: REAL_GIT }), file);
  const result = spawnSync(file, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, spawnSync(REAL_GIT, ["--version"], { encoding: "utf8" }).stdout);
});

test("installed launcher intercepts the command emitted by Herdr", (t) => {
  const f = fixture(t);
  const file = installNativeCleanup({ binDir: path.join(f.repo, "bin"), gitBin: REAL_GIT });
  const result = spawnSync(file, ["-C", f.repo, "worktree", "remove", f.checkout], {
    env: f.env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.checkout), false);
  assert.deepEqual(f.resources(), { containers: [], volumes: [] });
});

test("installer refuses a dangling Git symlink", (t) => {
  const f = fixture(t);
  const binDir = path.join(f.repo, "bin");
  fs.mkdirSync(binDir);
  fs.symlinkSync("missing-git", path.join(binDir, "git"));
  assert.throws(() => installNativeCleanup({ binDir, gitBin: REAL_GIT }), /refusing to replace/);
  assert.equal(fs.readlinkSync(path.join(binDir, "git")), "missing-git");
});

test("finishing partial removal never follows symlinks outside the checkout", (t) => {
  const f = fixture(t);
  const external = path.join(f.repo, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "keep"), "keep");
  fs.symlinkSync(external, path.join(f.checkout, "blocked", "external"));
  // Git ignores the generated symlink, allowing the regular non-force removal.
  fs.writeFileSync(path.join(f.checkout, ".gitignore"), "blocked/external\n");
  spawnSync(REAL_GIT, ["-C", f.checkout, "add", ".gitignore"]);
  const commit = spawnSync(
    REAL_GIT,
    [
      "-C",
      f.checkout,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "ignore generated symlink",
    ],
    { encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
  fs.chmodSync(path.join(f.checkout, "blocked"), 0o555);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(external, "keep"), "utf8"), "keep");
  assert.equal(fs.existsSync(f.checkout), false);
});
