#!/usr/bin/env bash
# Run as dev; no credentials, external services, or browser downloads are needed.
set -euo pipefail

test "$(id -un)" = dev
test "$(node --version)" = v24.18.0
test "$(bun --version)" = 1.4.2
tofu version -json | jq -e '.terraform_version == "1.12.0"'
gitleaks version | grep -Fx 8.30.1
typos --version | grep -F 1.35.5
oasdiff --version | grep -F 1.17.0

for tool in git bash make docker dockerd gh curl jq gpg env find grep sed awk ps lsblk ip tar gzip unzip xz sudo cloudflared omp rtk lazydocker btop codex claude opencode wakatime-cli circleci chromium wrangler yazi lazygit nvim vim vi fd file 7z unar lsar ffmpegthumbnailer pdfinfo convert identify rg fzf zoxide; do
  command -v "$tool"
done
test -s /etc/ssl/certs/ca-certificates.crt
for tool in git make docker dockerd gh cloudflared omp rtk lazydocker btop codex claude opencode chromium yazi lazygit nvim; do
  "$tool" --version
done

docker compose version
docker buildx version
direnv version
playwright --version
wakatime-cli --version
circleci version
WRANGLER_SEND_METRICS=false wrangler --version
fd --version
test "$(readlink -f "$(command -v vim)")" = "$(readlink -f "$(command -v nvim)")"
# oh-my-bash + ble.sh + compact-agnoster + git aliases are baked into dev's
# .bashrc; assert the framework, line editor, theme, and aliases all landed.
test -f "$HOME/.oh-my-bash/oh-my-bash.sh"
test -f "$HOME/.local/share/blesh/ble.sh"
test -f "$HOME/.config/oh-my-bash/compact-agnoster.sh"
test -f "$HOME/.config/oh-my-bash/git-aliases.sh"
grep -q 'omp-shell' "$HOME/.bashrc"
test "$(bash -ic 'type gs gc ga gco gp gpl' 2>/dev/null | grep -c 'is aliased to')" -eq 6
bash -ic 'type gs' 2>/dev/null | grep -q "aliased to .git status."
ls -d "${PLAYWRIGHT_BROWSERS_PATH:?}"/chromium_headless_shell-* >/dev/null
node -e 'require.resolve("playwright"); require("playwright").chromium'
node --input-type=module -e 'import("playwright").then(m => { if (!m.chromium) process.exit(1) })'

node <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

async function checkMcp(command) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-'));
  const child = spawn(command, [], { cwd, env: { ...process.env, CBM_EPHEMERAL: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  let settled = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${command}: MCP startup timed out`)), 30000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => { if (!settled) fail(new Error(`${command}: exited before tools/list (${code})`)); });
      const send = value => child.stdin.write(JSON.stringify(value) + '\n');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.error) { fail(new Error(`${command}: ${JSON.stringify(message.error)}`)); return; }
          if (message.id === 1) {
            try { assert.ok(message.result?.capabilities?.tools, `${command}: no tools capability`); } catch (error) { fail(error); return; }
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (message.id === 2) {
            try {
              assert.ok(message.result.tools.some(tool => /memory|session|graph|project|code|search/.test(tool.name)), `${command}: expected codebase/session tools`);
            } catch (error) { fail(error); return; }
            settled = true;
            clearTimeout(timer);
            console.log(`${command}: MCP initialize and tools/list passed`);
            resolve();
          }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vibecode-essential-smoke', version: '1.0.0' } } });
    });
  } finally {
    child.stdin.end();
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

(async () => {
  await checkMcp('codebase-memory-mcp');
  await checkMcp('codebase-memory-session-mcp');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>vibecode-essential Chromium works</h1>');
    assert.equal(await page.locator('h1').textContent(), 'vibecode-essential Chromium works');
    console.log(`Chromium ${browser.version()}: browser launch and DOM check passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS

echo 'vibecode-essential smoke checks passed.'
