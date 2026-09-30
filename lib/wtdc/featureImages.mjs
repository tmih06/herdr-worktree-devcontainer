// Shared images depend on build inputs, while config snapshots and containers
// remain per worktree. Cache hits must never freeze mutable remote dependencies.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { tryRun } from "./run.mjs";
import { STATE_DIR } from "./context.mjs";
import { parseJsonc } from "./jsonc.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export function imageId(ref, { strict = false } = {}) {
  const result = tryRun("docker", ["image", "inspect", ref, "--format", "{{.Id}}"], {
    timeout: 30_000,
  });
  const id = (result.stdout || "").trim();
  if (strict && (result.status !== 0 || !imageIdPattern.test(id))) {
    const error = (result.stderr || result.stdout || "Docker inspection did not complete").trim();
    if (!/no such (image|object)/i.test(error)) throw new Error(error);
  }
  return result.status === 0 && imageIdPattern.test(id) ? id : "";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function hashDirectory(hash, directory, relative = "") {
  for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
    const file = path.join(relative, name);
    const absolute = path.join(directory, file);
    const stat = fs.statSync(absolute);
    hash.update(
      JSON.stringify([file, stat.mode & 0o777, stat.isDirectory() ? "directory" : "file"]),
    );
    if (stat.isDirectory()) hashDirectory(hash, directory, file);
    else hash.update(digest(fs.readFileSync(absolute)));
  }
}

export function featureImagePlan(config, directory, identity, { strict = false } = {}) {
  const fallback = {
    image: `wtdc-features-${digest(path.resolve(identity)).slice(0, 12)}:latest`,
    reuse: false,
  };
  const refs = Object.keys(config.features);
  const unavailable = (reason) => ({ ...fallback, reason });
  if (!config.image || config.build) return unavailable("Dockerfile build");
  if (JSON.stringify(config).includes("${")) return unavailable("variable build inputs");
  if (refs.some((ref) => !ref.startsWith("./"))) return unavailable("remote features");
  for (const ref of refs) {
    const metadata = parseJsonc(
      fs.readFileSync(path.join(directory, ref, "devcontainer-feature.json"), "utf8"),
    );
    if (Object.keys(metadata.dependsOn || {}).length)
      return unavailable("remote feature dependencies");
    if (JSON.stringify(metadata).includes("${")) return unavailable("variable feature metadata");
  }
  const baseImage = imageId(config.image, { strict });
  if (!baseImage) return unavailable("base image not available locally");
  const version = tryRun("devcontainer", ["--version"], { timeout: 30_000 });
  if (version.status !== 0 || !version.stdout.trim())
    return unavailable("Dev Containers CLI unavailable");
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify(
      canonical({
        schema: 1,
        cli: version.stdout.trim(),
        config: { ...config, image: baseImage },
        featureOrder: refs,
      }),
    ),
  );
  for (const ref of refs) {
    hash.update(ref);
    hashDirectory(hash, path.join(directory, ref));
  }
  return {
    image: `wtdc-features-${hash.digest("hex").slice(0, 24)}:latest`,
    reuse: true,
    baseImage,
  };
}

/** Let one process build a shared image, and recover locks left by a dead owner. */
export function withFeatureImageLock(image, timeout, action) {
  const directory = path.join(STATE_DIR, "feature-images");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, `${digest(image)}.lock`);
  const deadline = Date.now() + timeout;
  let acquired = false;
  while (!acquired) {
    try {
      // Creating a PID symlink is atomic: a crash cannot leave an empty owner file.
      fs.symlinkSync(String(process.pid), lock);
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = fs.readlinkSync(lock);
        const pid = Number(owner);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code === "ESRCH" && fs.readlinkSync(lock) === owner)
              fs.rmSync(lock, { force: true });
          }
        }
      } catch {
        /* Another owner may have just released the lock. */
      }
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for shared feature image ${image}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return action();
  } finally {
    if (fs.readlinkSync(lock) === String(process.pid)) fs.rmSync(lock, { force: true });
  }
}

export function uidImageTag(featureImage, config) {
  if (
    config.updateRemoteUserUID === false ||
    JSON.stringify([config.remoteUser, config.containerUser]).includes("${")
  )
    return "";
  const base = imageId(featureImage);
  if (!base) return "";
  const { uid, gid } = os.userInfo();
  return `wtdc-features-${digest(JSON.stringify({ schema: 1, base, uid, gid, remoteUser: config.remoteUser, containerUser: config.containerUser, updateRemoteUserUID: config.updateRemoteUserUID })).slice(0, 24)}-uid:latest`;
}

/** Publish the CLI's immutable startup image, without capturing container writes. */
export function cacheUidImage(container, tag, featureImage) {
  if (!tag || !container) return;
  try {
    const result = tryRun("docker", ["inspect", "--format", "{{.Image}}", container], {
      timeout: 30_000,
    });
    const id = (result.stdout || "").trim();
    if (result.status === 0 && imageIdPattern.test(id) && id !== imageId(featureImage))
      tryRun("docker", ["tag", id, tag], { timeout: 30_000 });
  } catch {
    /* Optional caching cannot turn a successful startup into failure. */
  }
}
