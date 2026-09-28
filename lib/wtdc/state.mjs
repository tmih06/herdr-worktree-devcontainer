// Durable plugin state.
//
// One JSON document keyed by absolute worktree checkout path. Herdr owns the
// directory; the format and lifecycle belong to the plugin, because there is no
// plugin storage API in v1.
//
//   { "version": 1,
//     "entries": {
//       "/home/me/.herdr/worktrees/feat": {
//         "label": "feat", "slug": "feat", "project": "myrepo",
//         "checkout_path": "/home/me/.herdr/worktrees/feat",
//         "container_id": "abc123", "container_name": "herdr-myrepo-feat",
//         "container_workspace": "/workspaces/feat", "remote_user": "node",
//         "merged_config": "…/merged/devcontainer.json",
//         "source_config": "…/.devcontainer/devcontainer.json"
//       }
//     } }
//
// The `container_*` fields are what the shell dispatcher (lib/wtdc/shell.mjs)
// reads on every new pane to decide whether to enter the container, so they
// must stay populated.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, DEFAULT_STATE_FILE } from './context.mjs';

// Resolved per call rather than once at import, so a test (or any caller) can
// point the plugin at a different state file within one process.
function stateFile() {
  return process.env.WTDC_STATE_FILE || DEFAULT_STATE_FILE;
}

function read() {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (doc && typeof doc === 'object' && doc.entries) return doc;
  } catch { /* missing or corrupt state is treated as empty */ }
  return { version: 1, entries: {} };
}

/** Write via a sibling temp file and rename, so a crash cannot truncate state. */
function write(doc) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function get(checkout) {
  const entry = read().entries[checkout];
  return entry ? { ...entry, checkout_path: checkout } : null;
}

export function has(checkout) {
  return Boolean(read().entries[checkout]);
}

export function set(checkout, entry) {
  const doc = read();
  doc.entries[checkout] = entry;
  write(doc);
}

/** Merge fields into an existing entry. Returns false when there is no entry. */
export function patch(checkout, fields) {
  const doc = read();
  if (!doc.entries[checkout]) return false;
  doc.entries[checkout] = { ...doc.entries[checkout], ...fields };
  write(doc);
  return true;
}

export function del(checkout) {
  const doc = read();
  if (!doc.entries[checkout]) return false;
  delete doc.entries[checkout];
  write(doc);
  return true;
}

export function list() {
  return Object.entries(read().entries).map(([checkout, entry]) => ({ ...entry, checkout_path: checkout }));
}

export function findByContainer(containerId) {
  return list().filter((e) => e.container_id === containerId);
}

/**
 * Resolve a working directory to the container that backs it.
 *
 * The longest matching checkout path wins, so a worktree nested inside another
 * checkout resolves to its own container rather than the parent's. This is the
 * hot path for every pane the dispatcher opens.
 */
export function findByCwd(cwd) {
  const matches = list().filter((e) => {
    const base = e.checkout_path;
    return typeof base === 'string' && base !== '' && (cwd === base || cwd.startsWith(`${base}/`));
  });
  matches.sort((a, b) => b.checkout_path.length - a.checkout_path.length);
  return matches[0] || null;
}
