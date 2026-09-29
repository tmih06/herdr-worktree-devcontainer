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

import { tryRun } from './run.mjs';

/** How long the registry may take before the answer is "unknown" rather than a hang. */
const REGISTRY_TIMEOUT_MS = 5000;

/** The architecture this host runs, as the image registries name them. */
function hostArch() {
  const arch = (process.arch || '').replace('x64', 'amd64');
  if (arch === 'arm64') return 'arm64';
  return arch || 'amd64';
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
 * `downloadBytes` is the compressed size of this host's variant, which is what a pull
 * would actually move. An architecture the tag does not publish answers null, rather than
 * a number for some other platform.
 */
export function remoteImage(ref, timeoutMs = REGISTRY_TIMEOUT_MS) {
  if (!ref) return null;

  const head = tryRun('docker', ['buildx', 'imagetools', 'inspect', ref], { timeout: timeoutMs });
  if (head.status !== 0) return null;
  const digest = /^Digest:\s+(\S+)/m.exec(head.stdout || '');
  if (!digest) return null;

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
  const remote = remoteImage(ref);
  const state = compareImage(local, remote);

  return {
    ref,
    state,
    // A present image reports its size on disk; an absent one reports what pulling it
    // would cost. Reporting the wrong one of the two is how "quick" turns out not to be.
    size: state === 'absent'
      ? (remote ? formatSize(remote.downloadBytes) : '')
      : (local ? formatSize(local.sizeBytes) : ''),
  };
}
