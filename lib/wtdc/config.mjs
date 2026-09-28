// Configuration loading.
//
// Precedence is environment > user config.env > shipped defaults, so any value
// can be overridden for a single invocation without editing a file.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_FILE, USER_CONFIG_FILE } from './context.mjs';

/**
 * Parse a shell-ish `KEY=value` file.
 *
 * Values may be bare, single-quoted, or double-quoted; `#` starts a comment
 * outside quotes. A quoted value keeps its spaces, which matters for things
 * like `WTDC_CONFIG_CANDIDATES='.devcontainer/devcontainer.json …'`.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const DEFAULTS = {
  WTDC_ENABLED: '1',
  WTDC_ON_CREATE: 'prompt',
  WTDC_NOTIFY: '1',
  WTDC_BUILD_TIMEOUT: '1800',
  WTDC_KEEP_CONTAINER: '0',
  WTDC_EXTRA_MOUNTS: '',
  WTDC_CONFIG_CANDIDATES: '.devcontainer/devcontainer.json .devcontainer.json',
  WTDC_OPEN_CONTAINER_PANE: '1',
  WTDC_CONTAINER_ICON: '🐳',
  WTDC_TEMPLATE: '',
  WTDC_IMAGE: '',
  WTDC_IMAGE_REMOTE_USER: 'dev',
  WTDC_SHARE_HERDR_BIN: 'auto',
  WTDC_SHARE_HERDR_PLUGINS: 'auto',
};

/**
 * Load configuration, seeding the user's copy on first run the way the old
 * bash loader did, so an existing config.env keeps working untouched.
 */
export function loadConfig() {
  fs.mkdirSync(path.dirname(USER_CONFIG_FILE), { recursive: true });
  if (!fs.existsSync(USER_CONFIG_FILE) && fs.existsSync(DEFAULT_CONFIG_FILE)) {
    try {
      fs.copyFileSync(DEFAULT_CONFIG_FILE, USER_CONFIG_FILE);
    } catch { /* a read-only config dir is not fatal */ }
  }

  return {
    ...DEFAULTS,
    ...readEnvFile(DEFAULT_CONFIG_FILE),
    ...readEnvFile(USER_CONFIG_FILE),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('WTDC_')),
    ),
  };
}
