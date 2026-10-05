import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (ch) => `sha256:${ch.repeat(64)}`;

// A real HTTP registry on the loopback, so the digest probe exercises the OCI
// API path end to end (challenge → token → Docker-Content-Digest), not a stub
// inside the process. Runs as its own child because describe() is spawnSync —
// the parent event loop is blocked while the lookup runs.
function startRegistry(t, dir, mode, digest) {
  fs.writeFileSync(
    path.join(dir, "registry.mjs"),
    `import http from "node:http";
import fs from "node:fs";
const digest = process.env.IMAGE_TEST_DIGEST;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  if (pathname === "/token") {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify({token: "test-token"}));
    return;
  }
  if (pathname === "/v2/repo/manifests/latest") {
    if (["registry", "fallback-unavailable", "snap-unavailable"].includes(process.env.IMAGE_TEST_MODE)) {
      res.writeHead(500).end("registry unavailable");
      return;
    }
    if (!req.headers.authorization) {
      res.writeHead(401, {"www-authenticate": \`Bearer realm="http://127.0.0.1:\${server.address().port}/token",service="test",scope="repository:repo:pull"\`});
      res.end();
      return;
    }
    res.writeHead(200, {"docker-content-digest": digest});
    res.end();
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.env.IMAGE_TEST_PORT_FILE, String(server.address().port));
});
`,
  );
  const portFile = path.join(dir, "port");
  const child = spawn(process.execPath, [path.join(dir, "registry.mjs")], {
    env: {
      ...process.env,
      IMAGE_TEST_MODE: mode,
      IMAGE_TEST_DIGEST: digest,
      IMAGE_TEST_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("stub registry did not start");
    spawnSync("sleep", ["0.05"]);
  }
  return fs.readFileSync(portFile, "utf8").trim();
}

function imageFixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-image-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // snap-* modes simulate the containerd image store: the local Id is the tag
  // digest itself, so RepoDigests and Id carry the same value and there is no
  // separate config digest to compare.
  const stale = /-stale|snap-stale/.test(mode);
  const tagDigest = stale ? sha("b") : sha("a");
  const port = startRegistry(t, dir, mode, tagDigest);
  const ref = `127.0.0.1:${port}/repo:latest`;
  const checkout = path.join(dir, "checkout");
  fs.mkdirSync(path.join(checkout, ".devcontainer"), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, ".devcontainer", "devcontainer.json"),
    JSON.stringify({ image: ref }),
  );
  fs.writeFileSync(
    path.join(dir, "docker"),
    `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
const mode = process.env.IMAGE_TEST_MODE;
const ref = process.env.IMAGE_TEST_REF;
const snap = mode.startsWith("snap-");
const localTag = ${JSON.stringify(sha("a"))};
const pulled = fs.existsSync(process.env.IMAGE_TEST_PULLED);
const localRepoDigest = pulled ? ${JSON.stringify(sha("b"))} : localTag;
const localConfig = snap ? localRepoDigest : (pulled ? "sha256:config-new" : "sha256:config-current");
if (args[0] === "pull") {
  fs.writeFileSync(process.env.IMAGE_TEST_PULLED, "pulled");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  if (mode === "daemon" || mode === "absent" || mode === "fallback-absent") {
    console.error(mode === "daemon" ? "Cannot connect to the Docker daemon" : "Error response from daemon: No such image: " + ref);
    process.exit(1);
  }
  const format = args[args.indexOf("--format") + 1];
  if (format.startsWith("{{.Size}}|{{json .RepoDigests}}")) {
    const metadata = mode === "no-digest" || mode === "fallback-no-digest" ? "1048576|[]" : \`1048576|["\${ref.replace(/:[^/]+$/, "")}@\${localRepoDigest}"]\`;
    console.log(metadata + (format.endsWith("|{{.Id}}") ? "|" + localConfig : ""));
  } else if (format === "{{.Os}}/{{.Architecture}}") {
    console.log("linux/" + process.arch.replace("x64", "amd64"));
  }
  process.exit(0);
}
if (mode.startsWith("fallback-") || snap) {
  if (args[0] === "buildx") {
    console.error("docker: unknown command: docker buildx");
    process.exit(1);
  }
  if (mode === "fallback-unavailable") {
    console.error("registry unavailable");
    process.exit(1);
  }
  if (mode === "fallback-malformed") {
    console.log("not json");
    process.exit(0);
  }
  const arch = process.arch.replace("x64", "amd64");
  const other = arch === "arm64" ? "amd64" : "arm64";
  const manifest = digest => ({config: {digest}, layers: [{size: 1048576}]});
  const key = mode === "fallback-schema-v2" ? "SchemaV2Manifest" : "OCIManifest";
  const entries = [{Descriptor: {platform: {os: "linux", architecture: other}}, [key]: manifest("sha256:config-current")}];
  if (mode !== "fallback-no-platform") {
    entries.push({Descriptor: {platform: {os: "linux", architecture: arch}, digest: ${JSON.stringify(sha("c"))}}, [key]: manifest(mode === "fallback-stale" ? "sha256:config-new" : "sha256:config-current")});
  }
  if (mode === "fallback-legacy") {
    entries[1].Platform = entries[1].Descriptor.platform;
    delete entries[1].Descriptor;
  }
  console.log(JSON.stringify(mode === "fallback-schema-v2" || mode === "fallback-legacy" ? entries[1] : entries));
  process.exit(0);
}
if (mode === "registry" || mode === "buildx") {
  console.error(mode === "buildx" ? "docker: unknown command: docker buildx" : "registry unavailable");
  process.exit(1);
}
if (args[0] === "buildx") console.log("Digest: " + localTag);
else console.log("{}");
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    IMAGE_TEST_MODE: mode,
    IMAGE_TEST_REF: ref,
    IMAGE_TEST_PULLED: path.join(dir, "pulled"),
    HERDR_PLUGIN_ROOT: ROOT,
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
    WTDC_CHECKOUT: checkout,
    WTDC_CONFIG_SOURCE: "worktree",
    WTDC_TEMPLATE: "",
    WTDC_IMAGE: "",
    WTDC_OVERRIDE_IMAGE: "",
  };
  return {
    provision: () => {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { buildMerged } from ${JSON.stringify(path.join(ROOT, "lib/wtdc/devcontainer.mjs"))};
          buildMerged(${JSON.stringify(path.join(checkout, ".devcontainer/devcontainer.json"))}, ${JSON.stringify(path.join(dir, "merged.json"))}, {});`,
        ],
        { env, encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 0, result.stderr);
      return fs.existsSync(env.IMAGE_TEST_PULLED);
    },
    describe: () => {
      const result = spawnSync(process.execPath, [path.join(ROOT, "lib/wtdc/imageInfo.mjs"), ref], {
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    },
    // Drive the actual overlay through a PTY so this checks the user-visible
    // message as well as the JSON returned by the image lookup process.
    prompt: () => {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b""
try:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            output += os.read(master, 65536)
        if any(s in output for s in [b"local state unknown", b"already pulled", b"not on this machine", b"local image check failed", b"newer image published"]):
            break
    os.write(master, b"n")
    child.wait(timeout=2)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
sys.stdout.buffer.write(output)
`,
          process.execPath,
          path.join(ROOT, "panes/prompt.mjs"),
        ],
        { env, encoding: "utf8", timeout: 6000 },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    },
  };
}

test("an unavailable registry does not make a known local image unknown", (t) => {
  const f = imageFixture(t, "registry");
  const described = f.describe();
  assert.equal(described.state, "unknown");
  assert.equal(described.size, "1 MB");
  const output = f.prompt();
  assert.match(output, /already pulled.*published version unavailable/);
  assert.doesNotMatch(output, /local state unknown/);
});

test("a local image without a registry digest explains the missing comparison", (t) => {
  const f = imageFixture(t, "no-digest");
  const output = f.prompt();
  assert.match(output, /already pulled.*no registry digest/);
  assert.doesNotMatch(output, /local state unknown/);
});

test("missing Buildx still resolves the published digest over the registry API", (t) => {
  const f = imageFixture(t, "buildx");
  const described = f.describe();
  assert.equal(described.localState, "present");
  assert.equal(described.state, "up-to-date");
});

test("a containerd-store image whose Id is the tag digest reports current, not stale", (t) => {
  const f = imageFixture(t, "snap-current");
  const described = f.describe();
  assert.equal(described.state, "up-to-date");
  assert.match(f.prompt(), /already pulled, same as published/);
});

test("a containerd-store image still detects a moved tag", (t) => {
  const f = imageFixture(t, "snap-stale");
  assert.equal(f.describe().state, "update-available");
});

test("without Buildx, the host's manifest config identifies an up-to-date image", (t) => {
  const f = imageFixture(t, "fallback-current");
  assert.equal(f.describe().state, "up-to-date");
  assert.match(f.prompt(), /already pulled, same as published/);
});

test("without Buildx, a changed host manifest config reports an available update", (t) => {
  const f = imageFixture(t, "fallback-stale");
  assert.equal(f.describe().state, "update-available");
  assert.match(f.prompt(), /newer image published/);
});

test("provisioning a stale local tag clears the published-image warning", (t) => {
  const f = imageFixture(t, "fallback-stale");
  assert.equal(f.describe().state, "update-available");
  f.provision();
  assert.equal(f.describe().state, "up-to-date");
  assert.match(f.prompt(), /already pulled, same as published/);
});

test("provisioning keeps a current local image without pulling", (t) => {
  const f = imageFixture(t, "fallback-current");
  assert.equal(f.provision(), false);
  assert.equal(f.describe().state, "up-to-date");
});

test("an unavailable registry does not force a pull of an existing image", (t) => {
  const f = imageFixture(t, "fallback-unavailable");
  assert.equal(f.provision(), false);
  assert.equal(f.describe().localState, "present");
});

test("the manifest fallback supports a single Docker schema v2 manifest", (t) => {
  const f = imageFixture(t, "fallback-schema-v2");
  assert.equal(f.describe().state, "up-to-date");
});

test("the manifest fallback supports Docker's legacy Platform field", (t) => {
  const f = imageFixture(t, "fallback-legacy");
  assert.equal(f.describe().state, "up-to-date");
});

test("the config fallback can compare a local image without RepoDigests", (t) => {
  const f = imageFixture(t, "fallback-no-digest");
  const described = f.describe();
  assert.equal(described.state, "up-to-date");
  assert.equal(described.reason, "");
});

test("the manifest fallback supplies the compressed download size for an absent image", (t) => {
  const f = imageFixture(t, "fallback-absent");
  const described = f.describe();
  assert.equal(described.state, "absent");
  assert.equal(described.size, "1 MB");
});

test("a manifest for another architecture does not block the tag-digest answer", (t) => {
  const f = imageFixture(t, "fallback-no-platform");
  const described = f.describe();
  assert.equal(described.state, "up-to-date");
});

test("malformed manifest output does not block the tag-digest answer", (t) => {
  const f = imageFixture(t, "fallback-malformed");
  const described = f.describe();
  assert.equal(described.state, "up-to-date");
});

test("if the fallback also fails, report the registry failure", (t) => {
  const f = imageFixture(t, "fallback-unavailable");
  const described = f.describe();
  assert.equal(described.state, "unknown");
  assert.match(described.reason, /registry unavailable/);
});

test("a failed Docker inspection is unknown availability, rather than an absent image", (t) => {
  const f = imageFixture(t, "daemon");
  const described = f.describe();
  assert.equal(described.state, "unknown");
  assert.equal(described.localState, "unknown");
  assert.match(described.reason, /Docker daemon/);
  assert.match(f.prompt(), /local image check failed.*Docker daemon/);
});

test("Docker's no-such-image response means the image needs pulling", (t) => {
  const f = imageFixture(t, "absent");
  assert.equal(f.describe().state, "absent");
  assert.match(f.prompt(), /not on this machine.*will be pulled/);
});

test("image lookup command runs when invoked through a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-imageinfo-"));
  try {
    const alias = path.join(dir, "imageInfo.mjs");
    fs.symlinkSync(path.resolve(import.meta.dirname, "../lib/wtdc/imageInfo.mjs"), alias);
    const result = spawnSync(process.execPath, [alias], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ref: "", state: "unknown", size: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
