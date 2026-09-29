// The interactive container terminal, for the panes that open one.
//
// Two of them do: panes/container.mjs as a tab of its own, and panes/boot.mjs taking
// over its own pane once a build finishes. They have to land in the same shell, so
// neither assembles its own `docker exec` — both come through here, on top of the same
// planExec the shell dispatcher uses for every ordinary pane. A pane that reached its
// container by a different route would be a second thing to keep in step.

import { spawnSync } from 'node:child_process';
import { planExec } from './shell.mjs';

/** Resolve the `docker exec` argv for a provisioned worktree, or why there is none. */
export function planContainerShell(entry, hostCwd) {
  return planExec(entry, hostCwd);
}

/** Clear the screen and print what this terminal is. */
export function containerShellHeader({ label = '', workdir = '', note = '' } = {}) {
  return '\x1b[2J\x1b[H'
    + `\x1b[36m▸ dev container\x1b[0m  ${label}\n`
    + (workdir ? `\x1b[2m${workdir}\x1b[0m\n` : '')
    + (note ? `\x1b[2m${note}\x1b[0m\n` : '')
    + '\n';
}

/**
 * Become the container terminal, and return the exit status to leave with.
 *
 * Never throws and never hangs on a bad plan: a missing container is a message and a
 * failure code, because the caller is a pane that has to decide what to do next.
 */
export function enterContainerShell(entry, hostCwd, { label = '', note = '' } = {}) {
  const plan = planContainerShell(entry, hostCwd);

  if (!plan) {
    process.stdout.write('dev container: no container was recorded for this worktree\n');
    return 1;
  }
  if (plan.missing) {
    process.stdout.write(`dev container: the container for ${entry.checkout_path || hostCwd} is not running\n`);
    return 1;
  }

  process.stdout.write(containerShellHeader({ label, workdir: plan.workdir, note }));
  const result = spawnSync('docker', plan.args, { stdio: 'inherit' });
  return result.status === null ? 1 : result.status;
}
