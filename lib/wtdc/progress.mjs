// Progress reporting between `wtdc provision` and the boot pane.
//
// The provisioner is a short-lived child process; the pane that shows its
// progress is a separate process. They agree on one line format:
//
//   WTDC_PROGRESS<TAB>phase<TAB>percent<TAB>message
//
// A tagged line is used rather than a JSON stream because the pane also has to
// pass the child's ordinary output through, and a tag is cheap to recognise in
// a mixed stream without consuming anything else.
//
// The bar uses phase milestones. During a pull, Docker's per-layer updates
// advance that phase's portion; it never loops back or reports time as progress.

export const PREFIX = "WTDC_PROGRESS";

/**
 * The phases of a provision, in order, with the share of wall-clock each is
 * worth on a prebuilt image. Weights are what the bar interpolates across, so
 * they only have to be plausible, not measured.
 *
 */
export const PHASES = [
  { key: "inspect", label: "Reading devcontainer config", share: 0.05 },
  { key: "merge", label: "Preparing config", share: 0.05 },
  { key: "pull", label: "Pulling container image", share: 0.25 },
  { key: "up", label: "Building and starting container", share: 0.45 },
  { key: "ready", label: "Running postCreateCommand", share: 0.15 },
  { key: "finish", label: "Registering container", share: 0.05 },
];

/** Emit a progress line. Goes to stderr, where the pane listens. */
export function emit(phase, percent, message = "") {
  process.stderr.write(`${PREFIX}\t${phase}\t${Math.round(percent)}\t${message}\n`);
}

/** True when a line from the child's stderr is a progress line, not log output. */
export function isProgressLine(line) {
  return line.startsWith(`${PREFIX}\t`);
}

/** Split mixed CLI output on newlines and Docker's carriage-return redraws. */
export function outputRows(partial, chunk) {
  const parts = `${partial}${chunk}`.split(/\r\n|\r|\n/);
  return { rows: parts.slice(0, -1), partial: parts.at(-1) || "" };
}

const SIZE = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

function byteFraction(status) {
  const match = status.match(
    /([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB)\s*\/\s*([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB)/i,
  );
  if (!match) return 0;
  const current = Number(match[1]) * SIZE[match[2].toLowerCase()];
  const total = Number(match[3]) * SIZE[match[4].toLowerCase()];
  return total > 0 ? Math.min(1, current / total) : 0;
}

/** Estimate completion from Docker's layer updates; never decrease a layer's progress. */
export class DockerPullProgress {
  layers = new Map();

  update(line) {
    const match = line.match(/^([^\s:]+):\s*(.*)$/);
    if (!match) return null;
    const [, id, status] = match;
    let value;
    if (/^(Pull complete|Already exists)$/i.test(status)) value = 1;
    else if (/^Extracting\b/i.test(status)) value = 0.8 + 0.2 * byteFraction(status);
    else if (/^(Download complete|Verifying Checksum)$/i.test(status)) value = 0.8;
    else if (/^Downloading\b/i.test(status)) value = 0.8 * byteFraction(status);
    else if (/^(Pulling fs layer|Waiting)$/i.test(status)) value = 0;
    else return null;

    this.layers.set(id, Math.max(this.layers.get(id) || 0, value));
    return [...this.layers.values()].reduce((sum, part) => sum + part, 0) / this.layers.size;
  }
}

/** Filled cells for the setup bar, independent of repaint time. */
export function barCells(percent, width) {
  return Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
}

/** Split a progress line into its parts, or null if it is not one. */
export function parseProgressLine(line) {
  if (!isProgressLine(line)) return null;
  const [, phase, rawPercent, ...message] = line.split("\t");
  const percent = Number(rawPercent);
  const knownPhase = phase === "done" || PHASES.some((item) => item.key === phase);
  if (
    !knownPhase ||
    !rawPercent?.trim() ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100
  )
    return null;
  return { phase, percent, message: message.join("\t") };
}

/**
 * The cumulative percent at the start of a phase.
 *
 * Lets a caller report progress within a phase by interpolating between this
 * and the end of the same phase, without every caller recomputing the shares.
 */
export function phaseStart(key) {
  let acc = 0;
  for (const p of PHASES) {
    if (p.key === key) return acc;
    acc += p.share;
  }
  return acc;
}
