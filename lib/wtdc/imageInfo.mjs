// What Herdr is about to be asked to do, before it is asked.
//
// The prompt is the last moment a user can back out, and the two things that decide
// whether provisioning this worktree is a `docker run` or a multi-minute build are
// both invisible in the config file: whether the image is already on this machine, and
// whether the registry has published a newer one. Answering them needs `docker`, and
// one of them needs the network — so everything here is best-effort, bounded by a
// timeout, and shaped so a caller can render what it knows and say plainly that it does
// not know the rest. A prompt that blocks on a registry round-trip, or that fails to
// draw because a registry is slow, is worse than a prompt that says less.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { tryRun } from "./run.mjs";

/** How long the registry may take before the answer is "unknown" rather than a hang. */
const REGISTRY_TIMEOUT_MS = 5000;
const LOCAL_TIMEOUT_MS = 5000;

function lookupFailure(res, fallback) {
  // Keep diagnostics to one line for the prompt. Never infer absence from a
  // daemon, permission, missing executable, or timeout failure.
  return (
    (res.stderr || res.stdout || "").trim().split("\n")[0] ||
    (res.status === 127 ? "docker was not found on PATH" : fallback)
  );
}

/** The architecture this host runs, as the image registries name them. */
function hostArch() {
  const arch = (process.arch || "").replace("x64", "amd64");
  if (arch === "arm64") return "arm64";
  return arch || "amd64";
}

/** The platform this host runs, as `linux/arm64` and the registries spell it. */
export function hostPlatform() {
  return `linux/${hostArch()}`;
}

/**
 * The platform an image already on this machine was built for, or '' when it is not here.
 *
 * A tag can point at one image per machine while the tag is multi-arch, and nothing stops
 * the wrong one from being the one that is local: `docker pull --platform linux/amd64`, a
 * build run with an explicit platform, or a copy of a cache from another host all leave
 * the tag resolving to a variant this machine cannot execute. The result is a failure a
 * long way from its cause — the Dev Container CLI builds a uid-remapped copy of the image
 * with `FROM` on it, the shell in that copy will not exec, and what reaches the user is
 * twenty lines of minified stack trace ending in `exec format error`.
 */
export function localPlatform(ref) {
  if (!ref) return "";
  const res = tryRun("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref], {
    timeout: LOCAL_TIMEOUT_MS,
  });
  return res.status === 0 ? (res.stdout || "").trim() : "";
}

/** True when the tag is on this machine but for a platform this machine cannot run. */
export function platformMismatch(ref) {
  const local = localPlatform(ref);
  return local !== "" && local !== hostPlatform();
}

/**
 * The image as this machine has it, or null.
 *
 * `digest` is the index digest for a multi-arch tag — which is what a pull records and
 * what the registry reports for the same tag, so the two are comparable. Comparing a
 * local digest against a *per-platform* manifest digest would report every up-to-date
 * image as stale.
 */
export function localImage(ref) {
  return inspectLocalImage(ref).image;
}

function inspectLocalImage(ref) {
  if (!ref) return { image: null, state: "unknown", reason: "no image declared" };
  const res = tryRun(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}|{{json .RepoDigests}}|{{.Id}}", ref],
    { timeout: LOCAL_TIMEOUT_MS },
  );
  if (res.status !== 0) {
    const absent = /No such (image|object)\b/i.test(res.stderr || "");
    return {
      image: null,
      state: absent ? "absent" : "unknown",
      reason: absent ? "" : lookupFailure(res, "local Docker inspection failed or timed out"),
    };
  }

  const [size, repoDigests, id = ""] = (res.stdout || "").trim().split("|");
  let digests = [];
  try {
    digests = JSON.parse(repoDigests || "[]");
  } catch {
    /* an image built locally has no RepoDigests at all */
  }

  const digest = digests[0] ? digests[0].split("@")[1] || "" : "";
  // On Docker's containerd image store `.Id` is the *index* digest — the same
  // value RepoDigests holds — not the image config digest. Treating it as one
  // compares an index against the remote platform config, which can never be
  // equal, so every up-to-date image reported "newer image published". Only
  // trust `.Id` as a config digest when it is not the recorded RepoDigest.
  const idIsRepoDigest = digest !== "" && digest === id;
  const image = {
    present: true,
    sizeBytes: Number(size) || 0,
    digest,
    configDigest: idIsRepoDigest ? "" : id,
    manifestDigest: "",
    fromRegistry: digests.length > 0,
  };
  return { image, state: "present", reason: "" };
}

/**
 * The tag as the registry has it, or null.
 *
 * `downloadBytes` is the compressed size of this host's variant, which is what a pull would
 * actually move. It is only worked out when asked for, and the caller only asks when the
 * image is *not* already here: the size of an image on disk is the better answer anyway,
 * and working out the download size is by far the slower of the two registry calls — a
 * couple of seconds against twenty for a tag this host has never pulled. Neither call
 * bounds reliably either, because the timeout signals the docker CLI and then waits for
 * docker to die, so the caller must be off the main thread to be unaffected.
 */
export function remoteImage(ref, options = {}) {
  return inspectRemoteImage(ref, options).image;
}

function inspectRemoteImage(ref, { downloadSize = true, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  if (!ref) return { image: null, reason: "no image declared" };

  const head = tryRun("docker", ["buildx", "imagetools", "inspect", ref], { timeout: timeoutMs });
  if (head.status !== 0) {
    // Without buildx, resolve the tag's index digest over the OCI HTTP API so
    // the comparison works against RepoDigests — what a pull records — and not
    // just a per-platform config digest. The probe runs as a subprocess because
    // this module is synchronous; an async registry call would push await into
    // prompt rendering.
    const tag = resolveTagDigest(ref);
    const manifest = inspectManifest(ref, timeoutMs);
    const image = {
      digest: tag.digest || "",
      configDigest: manifest.image?.configDigest || "",
      manifestDigest: manifest.image?.manifestDigest || "",
      downloadBytes: downloadSize ? manifest.image?.downloadBytes || 0 : 0,
    };
    if (!image.digest && !manifest.image) {
      return { image: null, reason: manifest.reason || tag.reason };
    }
    return { image, reason: manifest.reason || tag.reason };
  }
  const digestMatch = /^Digest:\s+(\S+)/m.exec(head.stdout || "");
  if (!digestMatch) return { image: null, reason: "registry lookup returned no digest" };

  if (!downloadSize) return { image: { digest: digestMatch[1], downloadBytes: 0 }, reason: "" };

  const manifest = inspectManifest(ref, timeoutMs);
  return {
    image: {
      digest: digestMatch[1],
      manifestDigest: manifest.image?.manifestDigest || "",
      downloadBytes: manifest.image?.downloadBytes || 0,
    },
    reason: "",
  };
}

/**
 * The digest the registry currently assigns to `ref`, resolved over HTTP in a
 * subprocess so the synchronous image pipeline can use the async resolver. An
 * empty digest means the registry could not be reached or did not answer —
 * callers then fall back to manifest/config comparison or report unknown.
 */
function resolveTagDigest(ref) {
  const probe = tryRun(
    process.execPath,
    [fileURLToPath(new URL("./remoteTagDigest.mjs", import.meta.url)), ref],
    { timeout: LOCAL_TIMEOUT_MS },
  );
  if (probe.status !== 0) {
    return { digest: "", reason: lookupFailure(probe, "registry digest probe failed") };
  }
  const digest = (probe.stdout || "").trim();
  if (/^sha256:[0-9a-f]+$/i.test(digest)) return { digest, reason: "" };
  return { digest: "", reason: "registry digest probe returned no digest" };
}

/**
 * Built-in Docker fallback when Buildx is unavailable. A platform's manifest
 * digest and config digest are not comparable to a multi-arch RepoDigest —
 * RepoDigests records the digest of what the tag pointed at, i.e. the index.
 * Config comparison to the local image ID is the only same-level signal this
 * call supplies, and only on stores whose ID is the config digest.
 */
function inspectManifest(ref, timeoutMs) {
  const verbose = tryRun("docker", ["manifest", "inspect", "--verbose", ref], {
    timeout: timeoutMs,
  });
  if (verbose.status !== 0) {
    return { image: null, reason: lookupFailure(verbose, "registry lookup failed or timed out") };
  }
  try {
    const parsed = JSON.parse(verbose.stdout || "");
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const platform = entry?.Descriptor?.platform || entry?.Platform || {};
      if (platform.os !== "linux" || platform.architecture !== hostArch()) continue;
      const manifest = entry?.OCIManifest || entry?.SchemaV2Manifest;
      const configDigest = manifest?.config?.digest;
      if (typeof configDigest !== "string" || !configDigest) {
        return { image: null, reason: "manifest returned no image config digest" };
      }
      const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
      return {
        image: {
          configDigest,
          // The platform manifest's own digest. Not the index digest that a
          // pull stores in RepoDigests — kept separate so a single-arch local
          // RepoDigest can be compared to the real manifest, not the index.
          manifestDigest: typeof entry?.Descriptor?.digest === "string" ? entry.Descriptor.digest : "",
          downloadBytes: layers.reduce((sum, layer) => sum + (Number(layer.size) || 0), 0),
        },
        reason: "",
      };
    }
    return { image: null, reason: `registry returned no manifest for ${hostPlatform()}` };
  } catch {
    return { image: null, reason: "registry returned invalid manifest JSON" };
  }
}

/**
 * How the local image compares to the published one.
 *
 * `unknown` means the registry is unavailable or there are no comparable digests.
 * Buildx supplies a tag/index digest; the manifest fallback supplies a config
 * digest, which must be compared to the local image ID. Callers report inspection failures
 * separately; a missing local value here represents a confirmed absent image.
 */
export function compareImage(local, remote) {
  if (!local) return "absent";
  if (!remote) return "unknown";
  // RepoDigest holds the digest of what the tag pointed at — the index digest
  // for a multi-arch tag, the manifest digest for a single-arch one. When the
  // tag digest was resolved, equality is a real answer and inequality is a real
  // update. When only a platform *manifest* digest was resolved, equality still
  // proves current — but an inequality could just be index-vs-manifest for a
  // multi-arch tag, which is not evidence of anything, so it reports unknown.
  if (local.digest) {
    if (remote.digest) {
      return local.digest === remote.digest ? "up-to-date" : "update-available";
    }
    if (remote.manifestDigest && local.digest === remote.manifestDigest) {
      return "up-to-date";
    }
    if (!remote.configDigest) return "unknown";
  }
  if (local.configDigest && remote.configDigest) {
    return local.configDigest === remote.configDigest ? "up-to-date" : "update-available";
  }
  return "unknown";
}

/** A human-readable size, since these are large numbers either way. */
export function formatSize(bytes) {
  if (!bytes || bytes < 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/** Everything the prompt needs to describe the image, in one call. */
export function describeImage(ref) {
  const inspected = inspectLocalImage(ref);
  const local = inspected.image;
  // Only pay for the download size when there is a download to pay for.
  const published =
    inspected.state === "unknown"
      ? { image: null, reason: "" }
      : inspectRemoteImage(ref, { downloadSize: !local });
  const remote = published.image;
  const state = inspected.state === "unknown" ? "unknown" : compareImage(local, remote);
  const localFor = local ? localPlatform(ref) : "";

  return {
    ref,
    state,
    localState: inspected.state,
    reason:
      inspected.reason ||
      (state === "unknown" && local && !local.digest ? "no registry digest" : published.reason),
    // A present image reports its size on disk; an absent one reports what pulling it
    // would cost. Reporting the wrong one of the two is how "quick" turns out not to be.
    size:
      state === "absent"
        ? remote
          ? formatSize(remote.downloadBytes)
          : ""
        : local
          ? formatSize(local.sizeBytes)
          : "",
    // Whether the copy on this machine can actually run here. Only worth saying when it
    // cannot: it is the one property of the image that decides whether provisioning works
    // at all, and it is not something the config file or the registry can tell you.
    localPlatform: localFor,
    hostPlatform: hostPlatform(),
    wrongPlatform: localFor !== "" && localFor !== hostPlatform(),
  };
}

/**
 * Answer one lookup as JSON on stdout, for callers that must not block on it.
 *
 * Every call in here is a synchronous child process, and one of them waits on a registry
 * that can take seconds to answer or never answer. Run on the main thread, that is time the
 * caller cannot accept a keypress or repaint during — so a UI asks this question in a
 * process of its own instead.
 *
 *   node lib/wtdc/imageInfo.mjs <image-ref>
 */
let invokedDirectly = false;
if (process.argv[1]) {
  try {
    invokedDirectly =
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Importers may pass an argv path that no longer exists.
  }
}
if (invokedDirectly) {
  const ref = process.argv[2] || "";
  const result = ref ? describeImage(ref) : { ref: "", state: "unknown", size: "" };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
