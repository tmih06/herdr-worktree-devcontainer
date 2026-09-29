// Tests for the shell dispatcher.
//
// This is the piece that makes the whole design work: Herdr spawns it instead
// of a shell for every new pane, and it decides whether that pane belongs in a
// container. Getting it wrong is either "your terminals ignore the container"
// or "your other workspaces break", so the fall-through path matters as much as
// the redirect.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch directories, removed when the file finishes. See the note in unit.test.mjs:
// these are created per test, so leaving them behind is hundreds of directories a day.
const scratch = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-shell-"));
  scratch.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// A stub `docker` on PATH answers `ps -q` with a running container and
// resolves a passwd home, which is all planExec asks of it. The values are
// baked in rather than read from shell variables, so nothing here depends on
// escaping `$` out of a JS template literal.
function withStubDocker({ running = true, home = "node:x:1000:1000::/home/node:/bin/bash" } = {}) {
  const dir = tmp();
  const psq = running ? "echo cafe1234" : ":";
  const passwd = home ? `echo '${home}'` : ":";
  fs.writeFileSync(
    path.join(dir, "docker"),
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      `  "ps -q") ${psq} ;;`,
      `  "exec getent") ${passwd} ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(path.join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return dir;
}

const entry = (over = {}) => ({
  checkout_path: "/w/feat",
  container_id: "cafe1234",
  container_workspace: "/workspaces/feat",
  remote_user: "node",
  ...over,
});

test("planExec: redirects a pane in a provisioned worktree into the container", async () => {
  withStubDocker();
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  const plan = planExec(entry(), "/w/feat");
  assert.ok(plan.args, "expected a docker exec plan");
  assert.deepEqual(plan.args.slice(0, 5), ["exec", "-it", "-u", "node", "-e"]);
  assert.match(plan.args[5], /^HOME=/, "HOME must be supplied or a login shell breaks");
  assert.equal(plan.args[6], "-w");
  assert.equal(
    plan.args[7],
    "/workspaces/feat",
    "the worktree root maps to the container workspace",
  );
  assert.equal(plan.args[8], "cafe1234");
});

test("planExec: translates a subdirectory into the container path", async () => {
  withStubDocker();
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  const plan = planExec(entry(), "/w/feat/src/deep");
  assert.equal(plan.workdir, "/workspaces/feat/src/deep");
  assert.equal(plan.args[7], "/workspaces/feat/src/deep");
});

test("planExec: an entry with no container is not redirected", async () => {
  withStubDocker();
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  assert.equal(planExec(null, "/w/feat"), null);
  assert.equal(planExec(entry({ container_id: "" }), "/w/feat"), null);
});

test("planExec: a stopped container reports missing rather than execing into nothing", async () => {
  withStubDocker({ running: false });
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  const plan = planExec(entry(), "/w/feat");
  assert.ok(plan.missing, "the caller must fall back to a host shell");
  assert.equal(plan.args, undefined);
});

test("planExec: omits -u and -w when the container has no user or workspace", async () => {
  withStubDocker({ home: "" });
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  const plan = planExec(entry({ remote_user: "", container_workspace: "" }), "/w/feat");
  assert.deepEqual(plan.args.slice(0, 2), ["exec", "-it"]);
  assert.ok(!plan.args.includes("-u"), "no user means no -u");
  assert.ok(!plan.args.includes("-w"), "no workspace means no -w, rather than an empty -w");
});

test("planExec: always ends in a shell that exists, bash or sh", async () => {
  withStubDocker();
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  const plan = planExec(entry(), "/w/feat");
  const tail = plan.args.slice(-4).join(" ");
  assert.match(tail, /sh -lc if command -v bash/, "must fall back through bash to sh");
});

test("findByCwd is what keeps unrelated directories out of the container", async () => {
  const dir = tmp();
  process.env.WTDC_STATE_FILE = path.join(dir, "state.json");
  const state = await import("../lib/wtdc/state.mjs");

  state.set("/w/feat", { checkout_path: "/w/feat", container_id: "abc" });

  // A pane in a sibling directory that merely shares a name prefix must not be
  // captured by the worktree's container.
  assert.equal(state.findByCwd("/w/feature"), null);
  assert.equal(state.findByCwd("/home/other/project"), null);
  assert.ok(state.findByCwd("/w/feat/lib"), "a real subdirectory must match");
});

// ------------------------------------------------------- the container terminal

test("the container terminal header names the worktree and the container path", async () => {
  const { containerShellHeader } = await import("../lib/wtdc/containerShell.mjs");
  const raw = containerShellHeader({
    label: "feat",
    workdir: "/workspaces/feat",
    note: "Exit to close this terminal.",
  });

  // The setup screen draws a full-screen frame first, so a pane that hands over to this
  // has to clear it or the old frame stays behind the prompt.
  assert.ok(raw.startsWith("\x1b[2J\x1b[H"), "a reused pane has to be cleared first");
  const text = stripAnsi(raw);
  assert.match(text, /dev container {2}feat/, "the worktree it belongs to");
  assert.match(text, /\/workspaces\/feat/, "the path inside the container, not the host one");
  assert.match(text, /Exit to close this terminal\./);
});

test("the container terminal uses the same exec the dispatcher does", async () => {
  // Two panes reach the container — the one the provision action opens, and the setup
  // screen that takes its own pane over — and they have to land in the same shell. Both
  // come through here, on top of planExec, so there is only one set of arguments to keep
  // right.
  withStubDocker();
  const { planContainerShell, enterContainerShell } =
    await import("../lib/wtdc/containerShell.mjs");
  const { planExec } = await import("../lib/wtdc/shell.mjs");

  assert.deepEqual(planContainerShell(entry(), "/w/feat").args, planExec(entry(), "/w/feat").args);

  // And the exit status is the container shell's, so a pane that becomes one behaves
  // like a pane that was opened as one.
  let said = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    said += String(chunk);
    return true;
  };
  let status;
  try {
    status = enterContainerShell(entry(), "/w/feat", { label: "feat" });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(status, 0);
  assert.match(stripAnsi(said), /dev container/);
});

test("the container terminal reports a stopped container instead of hanging", async () => {
  // It runs in a pane that has to decide what to do next, so a container that is not
  // there is a message and a status — never a throw, and never a silent success.
  withStubDocker({ running: false });
  const { enterContainerShell } = await import("../lib/wtdc/containerShell.mjs");

  let said = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    said += String(chunk);
    return true;
  };
  let status;
  try {
    status = enterContainerShell(entry(), "/w/feat");
  } finally {
    process.stdout.write = write;
  }

  assert.equal(status, 1);
  assert.match(said, /not running/);
  assert.doesNotMatch(said, /exec -it/, "nothing may be execed into a container that is gone");
});

test("the container terminal refuses an entry with no container at all", async () => {
  withStubDocker();
  const { enterContainerShell } = await import("../lib/wtdc/containerShell.mjs");
  assert.equal(enterContainerShell(entry({ container_id: "" }), "/w/feat"), 1);
});
