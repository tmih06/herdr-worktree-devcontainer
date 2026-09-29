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

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tryRun } from './run.mjs';

/** How long the registry may take before the answer is "unknown" rather than a hang. */
const REGISTRY_TIMEOUT_MS = 5000;

/** The architecture this host runs, as the image registries name them. */
function hostArch() {
  const arch = (process.arch || '').replace('x64', 'amd64');
  if (arch === 'arm64') return 'arm64';
  return arch || 'amd64';
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
  if (!ref) return '';
  const res = tryRun('docker', [
    'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', ref,
  ]);
  return res.status === 0 ? (res.stdout || '').trim() : '';
}

/** True when the tag is on this machine but for a platform this machine cannot run. */
export function platformMismatch(ref) {
  const local = localPlatform(ref);
  return local !== '' && local !== hostPlatform();
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
  if (!ref) return null;
  const res = tryRun('docker', [
    'image', 'inspect', '--format', '{{.Size}}|{{json .RepoDigests}}', ref,
  ]);
  if (res.status !== 0) return null;

  const [size, repoDigests] = (res.stdout || '').trim().split('|');
  let digests = [];
  try {
    digests = JSON.parse(repoDigests || '[]');
  } catch { /* an image built locally has no RepoDigests at all */ }

  return {
    present: true,
    sizeBytes: Number(size) || 0,
    digest: digests[0] ? digests[0].split('@')[1] || '' : '',
    fromRegistry: digests.length > 0,
  };
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
export function remoteImage(ref, { downloadSize = true, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  if (!ref) return null;

  const head = tryRun('docker', ['buildx', 'imagetools', 'inspect', ref], { timeout: timeoutMs });
  if (head.status !== 0) return null;
  const digest = /^Digest:\s+(\S+)/m.exec(head.stdout || '');
  if (!digest) return null;

  if (!downloadSize) return { digest: digest[1], downloadBytes: 0 };

  const arch = hostArch();
  let downloadBytes = 0;
  const verbose = tryRun('docker', ['manifest', 'inspect', '--verbose', ref], { timeout: timeoutMs });
  if (verbose.status === 0) {
    try {
      const parsed = JSON.parse(verbose.stdout || '');
      for (const entry of (Array.isArray(parsed) ? parsed : [parsed])) {
        const platform = entry?.Descriptor?.platform || {};
        if (platform.os === 'linux' && platform.architecture === arch) {
          const layers = entry?.OCIManifest?.layers || [];
          downloadBytes = layers.reduce((sum, l) => sum + (l.size || 0), 0);
          break;
        }
      }
    } catch { /* size is a nicety, not the answer being asked for */ }
  }

  return { digest: digest[1], downloadBytes };
}

/**
 * How the local image compares to the published one.
 *
 * `unknown` covers everything this cannot answer — no docker, an offline registry, a tag
 * with no digest because it was built locally — and the caller must show that rather than
 * imply the image is current, which is the answer that would be most reassuring and least
 * true.
 */
export function compareImage(local, remote) {
  if (!local) return 'absent';
  if (!remote) return 'unknown';
  if (!local.digest) return 'unknown';
  return local.digest === remote.digest ? 'up-to-date' : 'update-available';
}

/** A human-readable size, since these are large numbers either way. */
export function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/** Everything the prompt needs to describe the image, in one call. */
export function describeImage(ref) {
  const local = localImage(ref);
  // Only pay for the download size when there is a download to pay for.
  const remote = remoteImage(ref, { downloadSize: !local });
  const state = compareImage(local, remote);
  const localFor = local ? localPlatform(ref) : '';

  return {
    ref,
    state,
    // A present image reports its size on disk; an absent one reports what pulling it
    // would cost. Reporting the wrong one of the two is how "quick" turns out not to be.
    size: state === 'absent'
      ? (remote ? formatSize(remote.downloadBytes) : '')
      : (local ? formatSize(local.sizeBytes) : ''),
    // Whether the copy on this machine can actually run here. Only worth saying when it
    // cannot: it is the one property of the image that decides whether provisioning works
    // at all, and it is not something the config file or the registry can tell you.
    localPlatform: localFor,
    hostPlatform: hostPlatform(),
    wrongPlatform: localFor !== '' && localFor !== hostPlatform(),
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = process.argv[2] || '';
  const result = ref ? describeImage(ref) : { ref: '', state: 'unknown', size: '' };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

export { fileURLToPath as _fileURLToPath };
