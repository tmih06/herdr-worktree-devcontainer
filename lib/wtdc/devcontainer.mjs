// devcontainer.json discovery, merge, and container lifecycle.
//
// The merge sets the lifecycle boundary the plugin needs: `devcontainer up`
// waits for postCreateCommand before the container is handed to Herdr.
//
// Everything else in the repo's config is left authoritative. An earlier
// version injected an sshd feature, published an SSH port, and installed a
// Herdr server inside the container, because a saved SSH machine requires all
// three. Panes now enter the container through the shell dispatcher
// (lib/wtdc/shell.mjs) instead, so the user's own features, remoteUser, and
// lifecycle commands are used as written.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ROOT, STATE_DIR } from "./context.mjs";
import { run, tryRun, have } from "./run.mjs";
import { parseJsonc } from "./jsonc.mjs";
import { detail, warn } from "./ui.mjs";

export function findConfig(worktree, candidates) {
  for (const rel of candidates.trim().split(/\s+/).filter(Boolean)) {
    const abs = path.resolve(worktree, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/**
 * The main worktree of the repository `worktree` belongs to, or '' when it is the main one.
 *
 * `git worktree list` always puts the main worktree first, so that line is the answer and
 * the question never has to be "which branch did this come from" — a worktree records the
 * commit it was created at, not the branch it was created from, and the two are routinely
 * different by the time anyone asks.
 */
export function mainWorktree(worktree) {
  const res = tryRun("git", ["-C", worktree, "worktree", "list", "--porcelain"]);
  if (res.status !== 0) return "";
  const first = (res.stdout || "").split("\n").find((l) => l.startsWith("worktree "));
  if (!first) return "";
  const main = first.slice("worktree ".length).trim();
  return main && path.resolve(main) !== path.resolve(worktree) ? main : "";
}

/**
 * The directory a config is looked up in, which is the worktree unless the config says
 * otherwise.
 *
 * `WTDC_CONFIG_SOURCE=main` reads the *main checkout's file on disk*, not the commit it was
 * branched from. That is the point: the main checkout is the one a person edits, so an edit
 * there is an edit to every worktree, and it takes effect without being committed. Reading
 * a commit instead would need a branch name that git does not record, and would ignore
 * every uncommitted change — the change most likely to be the one being made.
 */
export function configBaseDir(worktree, config) {
  const want = String(config.WTDC_CONFIG_SOURCE ?? "main")
    .trim()
    .toLowerCase();
  if (["worktree", "local", "self", "off", ""].includes(want)) return worktree;
  return mainWorktree(worktree) || worktree;
}

/** The config file this worktree should be built from. */
export function resolveConfigPath(worktree, config) {
  return findConfig(configBaseDir(worktree, config), config.WTDC_CONFIG_CANDIDATES);
}

/**
 * Where a worktree's merged config lives.
 *
 * Keyed on the *worktree*, never on the config path: with `WTDC_CONFIG_SOURCE=main` every
 * worktree shares one source file, and keying on that would hand them all one merged config
 * to overwrite each other with. The merged copy is per worktree regardless — it carries that
 * worktree's hostname and workspace — so the key is the worktree.
 *
 * The trailing hash is what keeps the readable part from being a lie. The slug alone is
 * truncated to stay a usable directory name, and truncation cuts exactly the part that
 * differs: two worktrees of the same repo under the same parent collided on one key and
 * silently clobbered each other's merged config.
 */
function mergedDirFor(worktree) {
  const abs = path.resolve(worktree);
  const slug = abs.replace(/[^A-Za-z0-9]/g, "_").slice(0, 48);
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
  return path.join(STATE_DIR, "merged", `${slug}-${hash}`);
}

export function mergedPathFor(worktree) {
  const dir = mergedDirFor(worktree);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "devcontainer.json");
}

/**
 * Resolve the prebuilt image, if any.
 *
 * A prebuilt image skips the per-workspace image build the CLI would otherwise
 * derive whenever a config declares any feature. That is the difference between
 * a 4s and a 25s+ provision.
 */
export function prebuiltImage(config) {
  if (config.WTDC_IMAGE) return config.WTDC_IMAGE;
  const tpl = config.WTDC_TEMPLATE;
  if (!tpl) return "";

  const manifestFile = path.join(ROOT, "images", "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch {
    warn(`WTDC_TEMPLATE=${tpl} but ${manifestFile} is missing`);
    return "";
  }

  const hit = (manifest.images || []).find((i) => i.name === tpl);
  if (!hit) {
    warn(`WTDC_TEMPLATE=${tpl} is not in images/manifest.json`);
    return "";
  }
  const tag = manifest.tag || "latest";
  return `${manifest.registry}/${manifest.prefix}-${hit.name}:${tag}`;
}

/**
 * Whether this image already ships the host's uid, so the CLI's remap is a no-op.
 *
 * Takes the image rather than the config on purpose. It used to read `prebuiltImage(config)`,
 * which meant it could only ever see the template image — so a config that named its own
 * image, which is the default now that `WTDC_TEMPLATE` is blank, was never checked and the
 * remap ran on every provision regardless of what the image said about itself.
 */
function imageUidMatchesHost(ref) {
  if (!ref) return false;
  return uidRemap(ref) === "match";
}

/**
 * Make sure the image is on this machine, so its labels can be read.
 *
 * The uid lives in a label, and a label on an image that has not been pulled is not
 * knowable — the answer comes back empty and the caller has to treat it as `unknown`, which
 * is the one answer that cannot stop the remap. So on the first provision of an image, pull
 * it first and then ask. Later provisions pay one `docker image inspect`.
 *
 * Best-effort. A pull that fails is not this function's error to report: the CLI pulls the
 * image anyway a moment later, and a registry that is briefly unreachable should not stop a
 * provision that was going to work without the pull.
 */
function ensureLocal(ref, onPull) {
  if (!ref) return false;
  if (tryRun("docker", ["image", "inspect", ref, "--format", "{{.Id}}"]).status === 0) return true;
  if (typeof onPull === "function") onPull(ref);
  // Stream Docker's layer progress through the provisioner's stdout/stderr to the
  // setup pane. Other callers keep the quiet pull they used before.
  const pulled =
    typeof onPull === "function"
      ? tryRun("docker", ["pull", ref], {
          timeout: 600_000,
          // Keep Docker output on the same pipe as our phase markers so the
          // dialog cannot receive the next phase before the last layer update.
          stdio: ["ignore", 2, 2],
        })
      : tryRun("docker", ["pull", "-q", ref], { timeout: 600_000 });
  return pulled.status === 0;
}

/**
 * Whether provisioning this image makes the CLI build a `vsc-…-uid` copy of it.
 *
 * The Dev Container CLI does not run the image directly: when the container user's uid
 * differs from the host's, it builds a copy with the uid rewritten first. On a host with a
 * different uid that is every provision, including ones that declare no features and look
 * exactly like a `docker run`.
 *
 * `unknown` is the honest answer for an image that does not say. The uid lives in the
 * image's `/etc/passwd`, and reading it means starting a container to ask, which is not a
 * question worth asking before the answer.
 */
function uidRemap(ref) {
  if (!ref) return "unknown";
  const res = tryRun("docker", [
    "image",
    "inspect",
    ref,
    "--format",
    '{{index .Config.Labels "devcontainer.remote.uid"}}',
  ]);
  const label = (res.stdout || "").trim();
  if (label === "") return "unknown";
  return label === String(os.userInfo().uid) ? "match" : "differs";
}

/**
 * The mounts a config declares, as something a dialog can put on a line.
 *
 * The spec allows a mount to be written either as a string in docker's `--mount` syntax or
 * as an object, and a config may use either or both. Both are read, so the prompt can
 * describe what the container will have rather than what the file happens to be shaped
 * like — and so that a string mount, whose `readonly` the CLI would otherwise drop without
 * a word, is reported as the file says it is rather than as the container turns out to be.
 */
function describeMounts(declared) {
  const out = [];
  for (const mount of Array.isArray(declared) ? declared : []) {
    if (typeof mount === "string") {
      const field = (key) => (new RegExp(`(?:^|,)${key}=([^,]+)`).exec(mount) || [])[1] || "";
      out.push({
        source: field("source"),
        target: field("target") || field("dst"),
        // Both spellings are docker's: a bare `readonly` and `readonly=true`. Matching
        // only the bare one reports a read-only mount as writable, which is the one answer
        // here that could talk someone out of a mount that is actually fine.
        readonly: /(?:^|,)readonly(?:=(?:true|1))?(?:,|$)/.test(mount),
        type: field("type"),
      });
    } else if (mount && typeof mount === "object") {
      out.push({
        source: mount.source || "",
        target: mount.target || "",
        readonly: mount.readonly === true,
        type: mount.type || "",
      });
    }
  }
  return out;
}

/**
 * Bind-mount the main repository's `.git` into the container.
 *
 * A linked worktree stores its git metadata as a `.git` FILE pointing at
 * `<main-repo>/.git/worktrees/<name>`, which lives outside the worktree. The
 * Dev Container CLI mounts only the workspace folder, so inside the container
 * that pointer dangles and every git command fails. Bind-mounting the common
 * directory at the identical host path is what makes it resolve; the path has
 * to match verbatim because the pointer inside the .git file holds the host's
 * absolute path.
 *
 * A main checkout is its own common directory and is already mounted as the
 * workspace, so it needs nothing.
 */
export function gitDirMount(worktree) {
  const res = tryRun("git", [
    "-C",
    worktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const common = (res.stdout || "").trim();
  if (!common || !fs.existsSync(common)) return null;
  if (common === worktree || common.startsWith(`${worktree}/`)) return null;
  return `type=bind,source=${common},target=${common}`;
}

/** The path the container sees the checkout at, e.g. /workspaces/feat. */
export function containerWorkspace(worktree) {
  const cid = containerFor(worktree);
  if (!cid) return "";
  const res = tryRun("docker", [
    "inspect",
    "-f",
    '{{ index .Config.Labels "devcontainer.local_workspace_folder" }}',
    cid,
  ]);
  return (res.stdout || "").trim();
}

export function containerFor(worktree) {
  const res = tryRun("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=devcontainer.local_folder=${worktree}`,
  ]);
  return (res.stdout || "").trim().split("\n").filter(Boolean)[0] || "";
}

export function containerIsRunning(containerId) {
  if (!containerId) return false;
  const res = tryRun("docker", ["ps", "-q", "--filter", `id=${containerId}`]);
  return (res.stdout || "").trim() !== "";
}

/** Longest a hostname may be, and the characters one may contain. */
const HOSTNAME_MAX = 63;

/**
 * Turn a branch name into something a container may be called.
 *
 * The point of naming a container after its branch is that the shell prompt says which
 * worktree you are in, so the name has to survive being typed and read in a prompt. A
 * hostname is a DNS label: letters, digits and hyphens, 63 characters, no leading or
 * trailing hyphen. `feat/payments` and `Fix_Thing` are not that, so they are folded.
 * Distinct branches can land on the same label, which costs nothing — hostnames need not
 * be unique, unlike container names.
 */
export function branchHostname(branch) {
  const label = String(branch || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HOSTNAME_MAX)
    .replace(/-+$/, "");
  // A label of only digits is legal but reads like an address, and an empty one is not
  // legal at all; both are better spelled out than passed to docker as-is.
  if (label === "" || /^\d+$/.test(label)) return `wt${label ? `-${label}` : ""}`;
  return label;
}

/** The branch a worktree is checked out on, or '' when it cannot be read. */
export function branchOf(worktree) {
  const res = tryRun("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = (res.stdout || "").trim();
  return res.status === 0 && branch && branch !== "HEAD" ? branch : "";
}

/**
 * The `--hostname` a container should get, or '' for none.
 *
 * `WTDC_HOSTNAME` is `branch` (the default) for the branch name, `off` for nothing, or a
 * literal hostname. An explicit `--hostname` in the repo's own runArgs always wins: the
 * repo is authoritative about its container, the same way it is about its image.
 */
export function hostnameFor(worktree, config) {
  const wanted = (config.WTDC_HOSTNAME === undefined ? "branch" : config.WTDC_HOSTNAME).trim();
  if (wanted === "" || wanted === "off" || wanted === "0" || wanted === "none") return "";
  if (wanted !== "branch") return branchHostname(wanted);
  return branchHostname(branchOf(worktree));
}

/**
 * What provisioning this worktree would do, without doing any of it.
 *
 * Shared with the prompt so the thing the user is shown and the thing that runs cannot
 * drift apart — a prompt that describes a different plan from the one executed is worse
 * than no prompt, because it is believed. Writes nothing, and no side effects beyond
 * resolving a template name.
 */
export function planProvision(src, config, worktree = "") {
  const plain = parseJsonc(fs.readFileSync(src, "utf8"));
  const prebuilt = prebuiltImage(config);

  const declaredImage = plain.image || "";
  const declaredFeatures = Object.keys(plain.features || {});

  const merged = { ...plain };

  // An image typed into the prompt wins over everything, and unlike a template it is
  // *only* an image: features stay, because someone changing the base image still wants
  // the features applied to it. Environment only, never a config key — it is a decision
  // made once, in front of the question, not a standing preference.
  const typed = (process.env.WTDC_OVERRIDE_IMAGE || "").trim();

  if (typed) {
    merged.image = typed;
  } else if (prebuilt) {
    merged.image = prebuilt;
    merged.features = {};
    if (config.WTDC_IMAGE_REMOTE_USER) merged.remoteUser = config.WTDC_IMAGE_REMOTE_USER;
  }

  // Checked against the image that is actually going to run, and for every source of one —
  // a config's own, a template, or one typed into the prompt — because the remap is the
  // CLI's default rather than something this config asked for. Without this the CLI builds a
  // `vsc-…-uid` copy of the image and runs that instead, which on a host whose uid already
  // matches the image's is a full copy of the filesystem to change nothing at all.
  if (imageUidMatchesHost(merged.image)) merged.updateRemoteUserUID = false;

  // The CLI's native lifecycle boundary waits for all commands in postCreateCommand,
  // including array and object forms. Keep the command value intact and ask `up` to wait
  // for the full hook before returning control to Herdr.
  merged.waitFor = "postCreateCommand";

  let hostname = "";
  if (worktree) {
    // runArgs is the one place the CLI passes extra flags straight to `docker run`, and
    // the hostname is set at create time — changing it later means recreating the
    // container, so it has to be in the config rather than fixed up afterwards.
    const runArgs = Array.isArray(plain.runArgs)
      ? plain.runArgs.filter((a) => typeof a === "string")
      : [];
    const alreadyNamed = runArgs.some(
      (a) => a === "--hostname" || a === "-h" || a.startsWith("--hostname="),
    );
    hostname = alreadyNamed ? "" : hostnameFor(worktree, config);
    if (hostname) merged.runArgs = [...runArgs, "--hostname", hostname];
  }

  // A typed image keeps the features, so it drops nothing — the same as no template at all.
  // Keyed off what actually happened rather than off `prebuilt`, or a template left in the
  // config would make the prompt report features as discarded while they are being applied.
  const dropped = !typed && prebuilt;
  const keptFeatures = Object.keys(merged.features || {});

  return {
    merged,
    image: merged.image || "",
    declaredImage,
    imageSource: typed
      ? "edited in the prompt"
      : prebuilt
        ? config.WTDC_IMAGE
          ? "WTDC_IMAGE"
          : "WTDC_TEMPLATE"
        : "devcontainer.json",
    declaredFeatures,
    droppedFeatures: dropped ? declaredFeatures : [],
    keptFeatures,
    // What the config lends the container from the host. On the plan because the prompt is
    // the last moment to notice that a path is not what you thought, or that a mount of
    // the host's own files is writable from inside.
    mounts: describeMounts(plain.mounts),
    // The only thing that makes the CLI derive a per-workspace image. Whether a template
    // was requested says nothing about it, which is the whole reason this is measured
    // here rather than inferred from the plugin's own settings.
    buildsImage: keptFeatures.length > 0,
    uidRemap: uidRemap(merged.image || ""),
    remoteUser: merged.remoteUser || "",
    hostname,
    postCreateCommand: plain.postCreateCommand || "",
  };
}

/**
 * Rewrite the repo's config into a temporary copy the CLI will accept.
 *
 * The copy lives outside the worktree, so the checkout stays pristine and
 * `git status` shows nothing after provisioning.
 */
export function buildMerged(src, out, config, worktree = "", onPull) {
  // The image has to be here before it is planned, not after: the uid that decides whether
  // the CLI's remap is skipped is read from a label, and a label on an image this machine
  // has not pulled cannot be read. Planning first and pulling after would mean the merged
  // config is written without the answer and never corrected — which is what left every
  // provision building a remap copy of an image that already carried the right uid.
  //
  // `planProvision` stays side-effect free, so the pull is here rather than in there. This
  // is also the only place it is needed: the prompt plans for display, where `unknown` is
  // the honest answer, and the CLI pulls the image regardless a moment later.
  const plannedImage = (() => {
    try {
      return planProvision(src, config, worktree).image;
    } catch {
      return "";
    }
  })();
  ensureLocal(plannedImage, onPull);

  const plan = planProvision(src, config, worktree);

  if (plan.droppedFeatures.length) {
    // Dropping declared features changes what the container contains, so
    // never do it quietly.
    warn(
      `using prebuilt image ${plan.image}, so these features are not applied: ${plan.droppedFeatures.join(", ")}`,
    );
    detail(
      "pick a template that already includes them, or unset WTDC_IMAGE/WTDC_TEMPLATE to keep them",
    );
  }
  if (plan.hostname) detail(`container hostname  ${plan.hostname}`);

  fs.writeFileSync(out, `${JSON.stringify(plan.merged, null, 2)}\n`);
  return plan;
}

/**
 * Build and start the container.
 *
 * Returns after the CLI's native `waitFor` boundary, set to postCreateCommand
 * in the merged config. The timeout uses the same seconds setting as the build UI.
 */
export function up(worktree, merged, config, onCreated) {
  const args = [
    "up",
    "--workspace-folder",
    worktree,
    "--config",
    merged,
    "--remove-existing-container",
  ];
  if (config.WTDC_EXTRA_MOUNTS) args.push("--mount", config.WTDC_EXTRA_MOUNTS);

  const share = herdrShareMount();
  if (share) args.push("--mount", share);

  // Not an optimisation: without this, git is unusable in a linked worktree.
  const gitMount = gitDirMount(worktree);
  if (gitMount) args.push("--mount", gitMount);

  const timeout = Number(config.WTDC_BUILD_TIMEOUT || 1800) * 1000;
  const out = run("devcontainer", args, { timeout });

  const payload = parseUpOutput(out);
  const containerId = payload.containerId || containerFor(worktree);

  // `up` returns once the configured lifecycle boundary has completed.
  if (typeof onCreated === "function") onCreated(containerId);

  return {
    containerId,
    containerWorkspace: payload.remoteWorkspaceFolder || containerWorkspace(worktree),
    remoteUser: payload.remoteUser || "",
  };
}

/** The CLI prints a JSON summary, but not always on the last line. */
function parseUpOutput(text) {
  const candidates = text.split("\n").reverse();
  for (const line of candidates) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      /* keep looking */
    }
  }
  return {};
}

/**
 * Reuse the host's herdr binary instead of downloading one per container.
 *
 * The CLI's --mount has no read-only option, so mounting the live binary would
 * hand the container write access to it. Mount a cache copy instead: the worst
 * a container can do is corrupt the cache, which is rebuilt on the next miss.
 */
function herdrShareMount() {
  if (process.platform !== "linux") return null;
  if (/^(0|false|no)$/i.test(process.env.WTDC_SHARE_HERDR_BIN || "auto")) return null;
  const hostBin = process.env.HERDR_BIN_PATH || "herdr";
  if (!have(hostBin, ["--version"])) return null;

  const cache = path.join(STATE_DIR, "cache", "herdr");
  if (!isRunnable(cache)) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.copyFileSync(hostBin, cache);
    fs.chmodSync(cache, 0o755);
  }
  return `type=bind,source=${cache},target=/usr/local/bin/herdr`;
}

function isRunnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return tryRun(file, ["--version"]).status === 0;
  } catch {
    return false;
  }
}

/**
 * Destroy the container.
 *
 * `devcontainer down` can refuse on a stale config or a renamed compose
 * project, and the container is what actually matters, so fall back to
 * `docker rm -f` and never report failure.
 */
export function down(worktree, merged, containerId) {
  if (merged && fs.existsSync(merged)) {
    tryRun(
      "devcontainer",
      ["down", "--workspace-folder", worktree, "--config", merged, "--remove-existing-container"],
      { timeout: 300_000 },
    );
  }
  if (containerId) {
    const res = tryRun("docker", ["ps", "-aq", "--filter", `id=${containerId}`]);
    if (res.stdout.trim() !== "") tryRun("docker", ["rm", "-f", containerId]);
  }
}

/**
 * Remove any container labelled with this worktree, tracked or not.
 *
 * A build that fails after `up` succeeded leaves a running container, and the
 * failure path drops the state entry so the worktree stays retryable. That
 * leaves the container with nobody tracking it, so the Docker label — not our
 * bookkeeping — is the authority here.
 */
export function removeOrphans(worktree) {
  const res = tryRun("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=devcontainer.local_folder=${worktree}`,
  ]);
  let removed = 0;
  for (const c of (res.stdout || "").split("\n").filter(Boolean)) {
    if (tryRun("docker", ["rm", "-f", c]).status === 0) removed += 1;
  }
  return removed;
}

export { run as runTool };
