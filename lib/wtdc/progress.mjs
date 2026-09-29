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
// Percentages are deliberately not invented. Pull and `devcontainer up` are
// indeterminate; Docker's layer output provides the detail during a pull.

export const PREFIX = "WTDC_PROGRESS";

/**
 * The phases of a provision, in order, with the share of wall-clock each is
 * worth on a prebuilt image. Weights are what the bar interpolates across, so
 * they only have to be plausible, not measured.
 *
 * `indeterminate` means the phase gives no internal progress signal: the pane
 * animates it and shows elapsed time instead of a percentage that would be a
 * guess.
 */
export const PHASES = [
  { key: "inspect", label: "Reading devcontainer config", share: 0.05 },
  { key: "merge", label: "Preparing config", share: 0.05 },
  { key: "pull", label: "Pulling container image", share: 0.25, indeterminate: true },
  { key: "up", label: "Building and starting container", share: 0.45, indeterminate: true },
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
