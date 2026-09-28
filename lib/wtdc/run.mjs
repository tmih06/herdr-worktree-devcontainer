// Thin wrappers over child_process.
//
// Every external tool this plugin uses is a CLI: docker, devcontainer, ssh,
// herdr. There is no native API to bind to, so these helpers exist to make the
// call sites readable and to give failures one consistent shape.

import { execFile, execFileSync, spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(message, { cmd, code, stderr } = {}) {
    super(message);
    this.name = 'CommandError';
    this.cmd = cmd;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Run a command, returning stdout. Throws CommandError on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  const res = spawnSyncCapture(cmd, args, opts);
  if (res.status !== 0) {
    throw new CommandError(
      `${cmd} ${args.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout || '').trim()}`,
      { cmd, code: res.status, stderr: res.stderr },
    );
  }
  return res.stdout;
}

function spawnSyncCapture(cmd, args, opts) {
  // execFileSync forwards the child's stderr to this process's stderr unless
  // stdio is given explicitly. That leaks raw docker/git noise into the
  // plugin's own output, so capture it and let callers decide what to show.
  const { stdio = ['ignore', 'pipe', 'pipe'], ...rest } = opts;
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio, ...rest,
    });
    return { status: 0, stdout: stdout || '', stderr: '' };
  } catch (err) {
    if (err.status === undefined && err.code !== 'ENOENT') throw err;
    return {
      status: err.status === undefined ? 127 : err.status,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

/** Run a command, returning { status, stdout, stderr }. Never throws on exit code. */
export function tryRun(cmd, args, opts = {}) {
  return spawnSyncCapture(cmd, args, opts);
}

/** True when the command exists and exits 0. */
export function have(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Start a long-running command, streaming its output to the current stdio. */
export function runStreaming(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export { execFile };
