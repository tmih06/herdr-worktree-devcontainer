import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const baseId = `sha256:${"a".repeat(64)}`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-feature-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "docker.json");
  fs.writeFileSync(
    data,
    JSON.stringify({ images: { "base:latest": baseId }, containers: {}, events: [] }),
  );
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const common = `
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
const file=process.env.FEATURE_TEST_DATA;
const state=JSON.parse(fs.readFileSync(file,"utf8"));
const args=process.argv.slice(2);
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const imageId=ref=>state.images[ref]||(Object.values(state.images).includes(ref)?ref:"");
`;
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}\n${common}
if(args[0]==="image"&&args[1]==="inspect"){
 if(state.slowInspect){fs.appendFileSync(path.join(path.dirname(file),"inspect-pids"),process.pid+"\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);}
 if(state.inspectError){console.error("Cannot connect to the Docker daemon");process.exit(1);}
 const ref=args[2]; const id=imageId(ref);
 if(!id){console.error("No such image: "+ref);process.exit(1);}
 const format=args[args.indexOf("--format")+1];
 if(format==="{{.Id}}")console.log(id);
 else if(format==="{{.Os}}/{{.Architecture}}")console.log("linux/"+process.arch.replace("x64","amd64"));
 process.exit(0);
}
if(args[0]==="inspect"){
 const container=state.containers[args.at(-1)];
 if(!container)process.exit(1);
 console.log(container.image);process.exit(0);
}
if(args[0]==="tag"){
 const id=imageId(args[1]);if(!id)process.exit(1);
 state.images[args[2]]=id;state.events.push({command:"tag",image:args[2]});save();process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "devcontainer"),
    `#!${process.execPath}\n${common}
if(args[0]==="--version"){console.log("0.89.0");process.exit(0);}
const config=JSON.parse(fs.readFileSync(args[args.indexOf("--config")+1],"utf8"));
if(args[0]==="build"){
 const image=args[args.indexOf("--image-name")+1];
 state.events.push({command:"build",image,config});
 if(state.failBuild){save();console.error("feature build failed");process.exit(1);}
 state.images[image]="sha256:"+createHash("sha256").update(image).digest("hex");save();process.exit(0);
}
if(args[0]==="up"){
 const remap=config.updateRemoteUserUID!==false;
 const id=imageId(config.image);if(!id){console.error("image missing");process.exit(1);}
 const actual=remap?"sha256:"+createHash("sha256").update(id+"-uid").digest("hex"):id;
 if(remap)state.images["vsc-test-"+Object.keys(state.containers).length+"-uid:latest"]=actual;
 const containerId="container"+Object.keys(state.containers).length;
 state.containers[containerId]={image:actual};
 state.events.push({command:"up",config,remap,imageId:actual});save();
 console.log(JSON.stringify({containerId,remoteWorkspaceFolder:"/workspaces/test",remoteUser:"dev"}));process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FEATURE_TEST_DATA: data,
    HERDR_PLUGIN_ROOT: root,
    HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
    HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
    WTDC_SHARE_HERDR_BIN: "0",
    WTDC_OVERRIDE_IMAGE: "",
  };
  const config = {
    WTDC_CONFIG_SOURCE: "worktree",
    WTDC_TEMPLATE: "",
    WTDC_IMAGE: "",
    WTDC_HOSTNAME: "off",
    WTDC_BUILD_TIMEOUT: "30",
  };
  function checkout(name, options = {}) {
    const folder = path.join(dir, name);
    const feature = path.join(folder, ".devcontainer/features/tools");
    fs.mkdirSync(feature, { recursive: true });
    fs.writeFileSync(
      path.join(feature, "devcontainer-feature.json"),
      JSON.stringify({ id: "tools", version: "1.0.0", name: "Tools" }),
    );
    fs.writeFileSync(path.join(feature, "install.sh"), "#!/bin/sh\necho installed\n");
    fs.writeFileSync(
      path.join(folder, ".devcontainer/devcontainer.json"),
      JSON.stringify({
        image: "base:latest",
        remoteUser: "dev",
        features: { "./features/tools": options },
      }),
    );
    return folder;
  }
  function start(folder) {
    const out = path.join(dir, "merged", path.basename(folder), "devcontainer.json");
    const code = `import fs from "node:fs";
      import {buildMerged,up} from ${JSON.stringify(path.join(root, "lib/wtdc/devcontainer.mjs"))};
      buildMerged(${JSON.stringify(path.join(folder, ".devcontainer/devcontainer.json"))},${JSON.stringify(out)},${JSON.stringify(config)},${JSON.stringify(folder)});
      const descriptor=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(path.dirname(out), "feature-build.json"))},"utf8"));
      const result=up(${JSON.stringify(folder)},${JSON.stringify(out)},${JSON.stringify(config)});
      console.log(JSON.stringify({descriptor,result}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    return {
      ...result,
      parsed: result.status === 0 ? JSON.parse(result.stdout.trim().split("\n").at(-1)) : null,
    };
  }
  const read = () => JSON.parse(fs.readFileSync(data, "utf8"));
  const write = (value) => fs.writeFileSync(data, JSON.stringify(value));
  function prompt(folder, expected, after = "", extraEnv = {}) {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b""
def read_frame(expected, timeout=5):
    global output
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            # Force fragmented PTY reads so an early substring cannot masquerade
            # as a complete render (the CI regression this helper guards).
            output += os.read(master, 1)
        frame = output.rsplit(b"\\x1b[2J\\x1b[H", 1)[-1]
        if expected.encode() in frame and b"y/" in frame and frame.endswith(b"\\x1b[0m\\r\\n\\r\\n"):
            return
    raise AssertionError("Timed out waiting for complete dialog frame: " + expected)
try:
    read_frame(sys.argv[3])
    ${after || "pass"}
    os.write(master, b"n")
    child.wait(timeout=2)
finally:
    if child.poll() is None:
        os.killpg(child.pid, 9)
        child.wait()
    os.close(master)
sys.stdout.buffer.write(output)
`,
        process.execPath,
        path.join(root, "panes/prompt.mjs"),
        expected,
      ],
      {
        env: { ...env, ...config, ...extraEnv, WTDC_CHECKOUT: folder },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split("\x1b[H")
      .at(-1)
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  }
  return { dir, checkout, start, read, write, prompt };
}

test("the dialog reports a shared feature and UID cache hit without building or starting anything", (t) => {
  const f = fixture(t);
  const first = f.start(f.checkout("warm"));
  assert.equal(first.status, 0, first.stderr);
  const folder = f.checkout("new-worktree");
  const events = f.read().events;
  const output = f.prompt(folder, "reuses cached image");
  assert.match(output, /local feature image cached/);
  assert.match(output, /UID\/GID-adjusted image cached/);
  assert.match(output, /reuses cached image/);
  assert.doesNotMatch(
    output.slice(output.lastIndexOf("Dev container")),
    /builds an image|and a uid-matched copy/,
  );
  assert.deepEqual(f.read().events, events);
  assert.equal(fs.existsSync(path.join(f.dir, "merged", "new-worktree")), false);
});

test("the dialog reports a cold cache and a feature-only hit accurately", (t) => {
  const f = fixture(t);
  const folder = f.checkout("cold");
  const cold = f.prompt(folder, "no matching local feature image");
  assert.match(cold, /builds an image/);
  assert.deepEqual(f.read().events, []);
  assert.equal(fs.existsSync(path.join(f.dir, "merged")), false);
  assert.equal(f.start(folder).status, 0);
  const state = f.read();
  for (const tag of Object.keys(state.images))
    if (tag.startsWith("wtdc-features-") && tag.endsWith("-uid:latest")) delete state.images[tag];
  f.write(state);
  const hit = f.prompt(folder, "reuses cached image");
  assert.match(hit, /local feature image cached/);
  assert.doesNotMatch(hit, /UID\/GID-adjusted image cached/);
  assert.match(hit, /uid-matched copy if/);
});

const waitForFrame = (text) => `read_frame(${JSON.stringify(text)}, 4)`;

test("editing a local feature while the dialog is open invalidates its displayed cache hit", (t) => {
  const f = fixture(t);
  const folder = f.checkout("feature-edit");
  assert.equal(f.start(folder).status, 0);
  const file = path.join(folder, ".devcontainer/features/tools/install.sh");
  const output = f.prompt(
    folder,
    "reuses cached image",
    `output = b""
    open(${JSON.stringify(file)}, "a").write("echo changed\\n")
    ${waitForFrame("no matching local feature image")}`,
  );
  assert.match(output, /no matching local feature image/);
  assert.doesNotMatch(output, /local feature image cached/);
  assert.equal(f.read().events.filter((event) => event.command === "build").length, 1);
});

test("an edited base image replaces the old cache status after typing settles", (t) => {
  const f = fixture(t);
  const folder = f.checkout("image-edit");
  assert.equal(f.start(folder).status, 0);
  const state = f.read();
  state.images["other:latest"] = `sha256:${"b".repeat(64)}`;
  f.write(state);
  const output = f.prompt(
    folder,
    "reuses cached image",
    `output = b""
    os.write(master, b"\\x1b[A\\x15other:latest\\r")
    ${waitForFrame("no matching local feature image")}`,
  );
  assert.match(output, /other:latest/);
  assert.match(output, /no matching local feature image/);
  assert.doesNotMatch(output, /local feature image cached/);
});

test("an unavailable Docker daemon reports an unknown cache rather than a cache miss", (t) => {
  const f = fixture(t);
  const folder = f.checkout("unavailable");
  const state = f.read();
  state.inspectError = true;
  f.write(state);
  const output = f.prompt(folder, "cache check failed");
  assert.match(output, /cache check failed: Cannot connect to the Docker daemon/);
  assert.doesNotMatch(output, /no matching local feature image|builds an image/);
});

test("a slow Docker inspection cannot delay the first frame or outlive a declined or closed dialog", (t) => {
  const f = fixture(t);
  const folder = f.checkout("busy");
  const state = f.read();
  state.slowInspect = true;
  f.write(state);
  const marker = path.join(f.dir, "inspect-pids");
  for (const closed of [false, true]) {
    fs.rmSync(marker, { force: true });
    const started = Date.now();
    f.prompt(
      folder,
      "Dev container",
      `deadline = time.monotonic() + 1
    while not os.path.exists(${JSON.stringify(marker)}) and time.monotonic() < deadline:
        time.sleep(0.01)${closed ? "\n    os.kill(child.pid, 15)" : ""}`,
    );
    assert.ok(
      Date.now() - started < 2000,
      "the first frame waited for synchronous Docker inspection",
    );
    const pids = fs.readFileSync(marker, "utf8").trim().split("\n");
    for (const pid of pids) {
      const stat = `/proc/${pid}/stat`;
      if (fs.existsSync(stat))
        assert.match(
          fs.readFileSync(stat, "utf8"),
          /\) Z /,
          "inspection still running after dialog exit",
        );
    }
  }
});

test("a disabled UID update and remote dependencies are described without promising an unusable cache", (t) => {
  const f = fixture(t);
  const folder = f.checkout("policy");
  const file = path.join(folder, ".devcontainer/devcontainer.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.updateRemoteUserUID = false;
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(f.start(folder).status, 0);
  const hit = f.prompt(folder, "reuses cached image");
  assert.doesNotMatch(hit, /uid-matched copy/);
  const metadata = path.join(folder, ".devcontainer/features/tools/devcontainer-feature.json");
  fs.writeFileSync(
    metadata,
    JSON.stringify({ id: "tools", dependsOn: { "ghcr.io/devcontainers/features/node:1": {} } }),
  );
  const output = f.prompt(folder, "shared cache unavailable");
  assert.match(output, /shared cache unavailable: remote feature dependencies/);
  assert.match(output, /builds an image/);
});

test("identical local features share one feature build and one UID-adjusted image across worktrees", (t) => {
  const f = fixture(t);
  const first = f.start(f.checkout("first"));
  const second = f.start(f.checkout("second"));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.parsed.descriptor.image, second.parsed.descriptor.image);
  const events = f.read().events;
  assert.equal(events.filter((e) => e.command === "build").length, 1);
  const starts = events.filter((e) => e.command === "up");
  assert.equal(starts[0].remap, true);
  assert.equal(starts[1].remap, false);
  assert.equal(starts[0].imageId, starts[1].imageId);
});

test("feature edits, option changes and a changed base image invalidate the shared image", (t) => {
  const f = fixture(t);
  const folder = f.checkout("edited", { version: "1" });
  const first = f.start(folder);
  assert.equal(first.status, 0, first.stderr);
  fs.appendFileSync(path.join(folder, ".devcontainer/features/tools/install.sh"), "echo changed\n");
  const edited = f.start(folder);
  assert.equal(edited.status, 0, edited.stderr);
  assert.notEqual(edited.parsed.descriptor.image, first.parsed.descriptor.image);
  const options = f.start(f.checkout("options", { version: "2" }));
  assert.equal(options.status, 0, options.stderr);
  assert.notEqual(options.parsed.descriptor.image, first.parsed.descriptor.image);
  const state = f.read();
  state.images["base:latest"] = `sha256:${"b".repeat(64)}`;
  f.write(state);
  const updated = f.start(f.checkout("updated", { version: "1" }));
  assert.equal(updated.status, 0, updated.stderr);
  assert.notEqual(updated.parsed.descriptor.image, first.parsed.descriptor.image);
  assert.equal(f.read().events.filter((e) => e.command === "build").length, 4);
});

test("a failed shared build leaves no cache hit and can be retried", (t) => {
  const f = fixture(t);
  const folder = f.checkout("retry");
  const state = f.read();
  state.failBuild = true;
  f.write(state);
  const failed = f.start(folder);
  assert.notEqual(failed.status, 0);
  assert.equal(f.read().events.filter((e) => e.command === "up").length, 0);
  const retry = f.read();
  retry.failBuild = false;
  f.write(retry);
  const ready = f.start(folder);
  assert.equal(ready.status, 0, ready.stderr);
  const reused = f.start(f.checkout("next"));
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(f.read().events.filter((e) => e.command === "build").length, 2);
});

test("workspace lifecycle edits preserve the image cache while user changes invalidate it", (t) => {
  const f = fixture(t);
  const folder = f.checkout("lifecycle");
  const first = f.start(folder);
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(folder, ".devcontainer/devcontainer.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.postCreateCommand = "echo per-worktree setup";
  fs.writeFileSync(file, JSON.stringify(config));
  const second = f.start(folder);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.parsed.descriptor.image, second.parsed.descriptor.image);
  assert.equal(f.read().events.filter((e) => e.command === "build").length, 1);
  assert.equal(
    f
      .read()
      .events.filter((e) => e.command === "up")
      .at(-1).config.postCreateCommand,
    config.postCreateCommand,
  );
  config.remoteUser = "another-user";
  fs.writeFileSync(file, JSON.stringify(config));
  const changed = f.start(folder);
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(changed.parsed.descriptor.image, first.parsed.descriptor.image);
  assert.equal(f.read().events.filter((e) => e.command === "build").length, 2);
});

test("removing cached Docker images causes a rebuild and an explicit UID policy stays authoritative", (t) => {
  const f = fixture(t);
  const folder = f.checkout("pruned");
  const first = f.start(folder);
  assert.equal(first.status, 0, first.stderr);
  const state = f.read();
  state.images = { "base:latest": baseId };
  f.write(state);
  const second = f.start(folder);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(f.read().events.filter((e) => e.command === "build").length, 2);
  const configFile = path.join(folder, ".devcontainer/devcontainer.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.updateRemoteUserUID = false;
  fs.writeFileSync(configFile, JSON.stringify(config));
  const third = f.start(folder);
  assert.equal(third.status, 0, third.stderr);
  const up = f
    .read()
    .events.filter((e) => e.command === "up")
    .at(-1);
  assert.equal(up.config.updateRemoteUserUID, false);
  assert.equal(up.config.image, third.parsed.descriptor.image);
});

test("mutable remote feature dependencies continue to build instead of getting a stale cache hit", (t) => {
  const f = fixture(t);
  const folders = [f.checkout("remote-first"), f.checkout("remote-second")];
  for (const folder of folders) {
    const metadataFile = path.join(
      folder,
      ".devcontainer/features/tools/devcontainer-feature.json",
    );
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    metadata.dependsOn = { "ghcr.io/devcontainers/features/node:1": {} };
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    const result = f.start(folder);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.parsed.descriptor.reuse, false);
  }
  assert.equal(f.read().events.filter((e) => e.command === "build").length, 2);
});

function lockChild(directory, action) {
  const code = `import fs from "node:fs";
    import {withFeatureImageLock} from ${JSON.stringify(path.join(root, "lib/wtdc/featureImages.mjs"))};
    withFeatureImageLock("shared-feature:latest",5000,()=>{${action}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, HERDR_PLUGIN_STATE_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

test("concurrent shared-image builders wait and use the first completed build", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-feature-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "image");
  const events = path.join(directory, "builds");
  const action = `if(!fs.existsSync(${JSON.stringify(marker)})){
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
    fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
    fs.appendFileSync(${JSON.stringify(events)},"build\\n");
  }
  console.log(fs.readFileSync(${JSON.stringify(marker)},"utf8"));`;
  const first = lockChild(directory, action);
  const second = lockChild(directory, action);
  const results = await Promise.all([first.done, second.done]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(results[0].stdout, results[1].stdout);
  assert.equal(fs.readFileSync(events, "utf8"), "build\n");
  assert.deepEqual(fs.readdirSync(path.join(directory, "feature-images")), []);
});

test("a killed image builder cannot block the next startup", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-feature-crash-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = lockChild(
    directory,
    'console.log("locked");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);',
  );
  t.after(() => owner.child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    owner.child.stdout.once("data", resolve);
    owner.child.once("error", reject);
    owner.done.then(
      (result) =>
        reject(new Error(`image builder exited before taking the lock: ${result.stderr}`)),
      reject,
    );
  });
  owner.child.kill("SIGKILL");
  await owner.done;
  const recovered = await lockChild(directory, 'console.log("recovered");').done;
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout.trim(), "recovered");
  assert.deepEqual(fs.readdirSync(path.join(directory, "feature-images")), []);
});
