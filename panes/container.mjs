#!/usr/bin/env node
// A single interactive shell inside the provisioned container.
//
// This is the one-shot terminal opened right after a build. The dispatcher
// (lib/wtdc/shell.mjs) handles every terminal opened afterwards, including
// splits and new tabs, so this only has to cover the first one.

import { spawnSync } from 'node:child_process';

const cid = process.env.WTDC_CONTAINER_ID || '';
const user = process.env.WTDC_CONTAINER_USER || '';
const label = process.env.WTDC_LABEL || '';
let cwd = process.env.WTDC_CONTAINER_WORKSPACE || '';

if (!cid) {
  process.stdout.write('error: no dev container id was supplied\n');
  process.exit(1);
}

const running = spawnSync('docker', ['ps', '-q', '--filter', `id=${cid}`], { encoding: 'utf8' });
if ((running.stdout || '').trim() === '') {
  process.stdout.write(`error: dev container ${cid.slice(0, 12)} is not running\n`);
  process.exit(1);
}

// `docker exec -u` does not reliably derive HOME, which breaks login shells and
// anything reading ~/.gitconfig, credentials, or agent config.
let home = '';
if (user) {
  const res = spawnSync('docker', ['exec', cid, 'getent', 'passwd', user], { encoding: 'utf8' });
  home = (res.stdout || '').split(':')[5]?.trim() || (user === 'root' ? '/root' : `/home/${user}`);
}

const args = ['exec', '-it'];
if (user) args.push('-u', user, '-e', `HOME=${home}`);
if (cwd) args.push('-w', cwd);
args.push(cid, 'sh', '-lc', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi');

process.stdout.write('\x1b[2J\x1b[H');
process.stdout.write(`\x1b[36m▸ dev container\x1b[0m  ${label || cid.slice(0, 12)}\n`);
if (cwd) process.stdout.write(`\x1b[2m${cwd}\x1b[0m\n`);
process.stdout.write('\x1b[2mConnected with docker exec. Exit to close this tab.\x1b[0m\n\n');

const result = spawnSync('docker', args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
