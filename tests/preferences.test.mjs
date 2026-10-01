import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as state from "../lib/wtdc/state.mjs";
import { configBaseDir, resolveConfigPath } from "../lib/wtdc/devcontainer.mjs";
import { planExec } from "../lib/wtdc/shell.mjs";

const root = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-preferences-"));
  const main = path.join(dir, "main");
  const checkout = path.join(dir, "custom");
  const file = path.join(dir, "state.json");
  const previous = process.env.WTDC_STATE_FILE;
  process.env.WTDC_STATE_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.WTDC_STATE_FILE;
    else process.env.WTDC_STATE_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(main, ".devcontainer"), { recursive: true });
  const git = (args) => {
    const result = spawnSync("git", ["-C", main, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(main, ".devcontainer/devcontainer.json"), '{"image":"main:latest"}');
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  git(["worktree", "add", "-q", "-b", "custom", checkout]);
  fs.writeFileSync(
    path.join(checkout, ".devcontainer/devcontainer.json"),
    '{"image":"custom:latest"}',
  );
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(dir, "herdr-calls");
  fs.writeFileSync(
    path.join(bin, "herdr"),
    `#!${process.execPath}
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ")+"\\n");
console.log(JSON.stringify({result:{panes:[]}}));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
console.log("[]");
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HERDR_PLUGIN_ROOT: root,
    HERDR_BIN_PATH: path.join(bin, "herdr"),
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: dir,
    WTDC_STATE_FILE: file,
    WTDC_CONFIG_SOURCE: "main",
    WTDC_CONFIG_SOURCE_OVERRIDE: "",
    WTDC_IMAGE: "",
    WTDC_TEMPLATE: "",
    WTDC_OVERRIDE_IMAGE: "",
    WTDC_CHECKOUT: checkout,
    WTDC_WORKSPACE: "w-test",
    WTDC_REOPEN: "1",
    WTDC_REBUILD: "0",
  };
  function prompt(keys, expected, { accept = false, missing = false } = {}) {
    if (missing) fs.rmSync(path.join(checkout, ".devcontainer/devcontainer.json"));
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1],sys.argv[2]], stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
output = b""
def frame(text):
    global output
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            output += os.read(master,65536)
        if text.encode() in output:
            return
    raise Exception("missing frame: " + text)
try:
    frame("Main checkout")
    output = b""
    os.write(master,sys.argv[3].encode())
    frame(sys.argv[4])
    os.write(master,b"${accept ? "y" : "n"}")
    child.wait(timeout=2)
    if ${accept ? "True" : "False"}:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if os.path.exists(sys.argv[5]) and "--entrypoint boot" in open(sys.argv[5]).read():
                break
            time.sleep(0.05)
finally:
    if child.poll() is None:
        os.killpg(child.pid,9)
        child.wait()
    os.close(master)
sys.stdout.buffer.write(output)
`,
        process.execPath,
        path.join(root, "panes/prompt.mjs"),
        keys,
        expected,
        calls,
      ],
      {
        env,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  }
  return { checkout, main, file, calls, prompt };
}

test("per-checkout config preference survives container deletion and wins over the global default", (t) => {
  const f = fixture(t);
  state.set(f.checkout, { container_id: "test" });
  state.setPreference(f.checkout, { config_source: "worktree", mode: "host" });
  state.del(f.checkout);
  const config = {
    WTDC_CONFIG_SOURCE: "main",
    WTDC_CONFIG_CANDIDATES: ".devcontainer/devcontainer.json",
  };
  assert.equal(configBaseDir(f.checkout, config), f.checkout);
  assert.equal(
    resolveConfigPath(f.checkout, config),
    path.join(f.checkout, ".devcontainer/devcontainer.json"),
  );
  assert.equal(
    configBaseDir(f.checkout, { ...config, WTDC_CONFIG_SOURCE_OVERRIDE: "main" }),
    f.main,
  );
  assert.deepEqual(state.list(), []);
  assert.equal(state.preference(f.checkout).mode, "host");
});

test("host preference prevents Docker exec even when the saved container is running", (t) => {
  const f = fixture(t);
  state.setPreference(f.checkout, { mode: "host" });
  assert.equal(planExec({ checkout_path: f.checkout, container_id: "test" }, f.checkout), null);
});

test("a nested worktree's host choice takes precedence over the parent project's container", (t) => {
  const f = fixture(t);
  const nested = path.join(f.main, "worktrees/nested");
  state.setPreference(f.main, { mode: "container" });
  state.setPreference(nested, { mode: "host" });
  assert.equal(
    planExec({ checkout_path: f.main, container_id: "parent" }, path.join(nested, "src")),
    null,
  );
  assert.equal(state.modeForCwd(path.join(f.main, "src")), "container");
});

test("the worktree source toggle previews custom config and persists it through the reopen handoff", (t) => {
  const f = fixture(t);
  const output = f.prompt("c", "custom:latest", { accept: true });
  assert.match(output, /Source\s+This worktree/);
  assert.equal(state.preference(f.checkout).config_source, "worktree");
  assert.match(fs.readFileSync(f.calls, "utf8"), /WTDC_CONFIG_SOURCE_OVERRIDE=worktree/);
  assert.match(fs.readFileSync(f.calls, "utf8"), /WTDC_PRESERVE_PANES=1/);
  assert.deepEqual(state.list(), []);
  assert.equal(
    fs.readFileSync(path.join(f.main, ".devcontainer/devcontainer.json"), "utf8"),
    '{"image":"main:latest"}',
  );
});

test("switching config source on an existing container requires rebuild rather than reopening stale config", (t) => {
  const f = fixture(t);
  state.set(f.checkout, {
    container_id: "test",
    source_config: path.join(f.main, ".devcontainer/devcontainer.json"),
  });
  const output = f.prompt("c", "Rebuild and reopen", { accept: true });
  assert.match(output, /custom:latest/);
  assert.match(fs.readFileSync(f.calls, "utf8"), /WTDC_REBUILD=1/);
});

test("canceling a config-source preview leaves the saved choice unchanged", (t) => {
  const f = fixture(t);
  state.setPreference(f.checkout, { config_source: "main" });
  f.prompt("c", "custom:latest");
  assert.equal(state.preference(f.checkout).config_source, "main");
});

test("a missing worktree config never silently falls back or launches a build", (t) => {
  const f = fixture(t);
  const output = f.prompt("cy", "Choose a valid devcontainer config", { missing: true });
  assert.match(output, /Source\s+This worktree/);
  assert.match(output, /none found/);
  assert.deepEqual(state.preference(f.checkout), {});
  assert.equal(fs.existsSync(f.calls), false);
});
