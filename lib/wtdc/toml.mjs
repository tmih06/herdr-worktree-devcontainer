// The one edit this plugin makes to a file it does not own.
//
// `terminal.default_shell` is the whole integration between the plugin and Herdr's
// pane spawning: with it pointing at the dispatcher, a pane in a provisioned
// worktree is `docker exec`ed into that worktree's container, and a pane anywhere
// else is the user's own shell. Without it, nothing says so — a terminal opened
// after a container is ready looks exactly like one opened before, because both
// are the host shell.
//
// So config.toml has to be edited, and it has to be edited without disturbing
// everything else in it. There is no TOML dependency here (the plugin ships as
// plain ESM with no build step), so this is a deliberately small, deliberately
// conservative reader: it understands table headers, dotted keys, and one-line
// assignments, and it refuses anything it cannot do unambiguously rather than
// guessing.

/** A `key = value` line at the top level of a table. Dotted keys count as one key. */
const ASSIGNMENT = /^(\s*)([A-Za-z0-9_.-]+|"[^"]*")(\s*=\s*)(.*)$/;
/** A `[table]` or `[[array of tables]]` header. */
const HEADER = /^(\s*)(\[\[?[^\]]+\]\]?)\s*(#.*)?$/;

/** Serialise a value as TOML. Strings are basic strings, which share JSON's escapes. */
function literal(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  throw new TypeError(`setTomlKey only writes strings, booleans and numbers, not ${typeof value}`);
}

/**
 * Split a line's value from whatever follows it.
 *
 * `tail` keeps the gap and the comment exactly as written — `#` inside a quoted string
 * is part of the value, not the start of a comment — so rewriting a value does not
 * reflow the rest of the line.
 */
function splitValue(text) {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') {
      const value = text.slice(0, i);
      const gap = /\s*$/.exec(value)[0];
      return { value: value.slice(0, value.length - gap.length), tail: gap + text.slice(i) };
    }
  }
  return { value: text, tail: '' };
}

/** The bare name of a table or key, with quotes stripped. */
function unquote(name) {
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(name.trim());
  return m ? (m[1] !== undefined ? m[1] : m[2]) : name.trim();
}

/** The value a line currently holds, without its quotes. */
const unquoted = (text) => text.trim().replace(/^["']|["']$/g, '');

/**
 * Set `key = value` inside `[table]`, creating the table if it has to.
 *
 * Returns `{ ok: true, text, changed, previous }`, or `{ ok: false, reason }` when the
 * file is shaped in a way this cannot edit without risking someone else's settings:
 * the same table declared twice, or the table written as an inline `table = { … }`.
 * An existing value for a different key is never touched.
 */
export function setTomlKey(text, table, key, value) {
  const source = String(text ?? '');
  const lines = source.split('\n');

  const headers = [];
  lines.forEach((line, i) => {
    const m = HEADER.exec(line);
    if (m && m[1] === '') headers.push({ line: i, name: unquote(m[2].replace(/^\[|\]$/g, '')) });
  });

  const matches = headers.filter((h) => h.name === table);
  if (matches.length > 1) {
    return { ok: false, reason: `[${table}] is declared ${matches.length} times, which is not valid TOML` };
  }

  // A dotted key (`terminal.default_shell = "…"`) is the same key written another
  // way, so replace it where it is rather than adding a table that collides with it.
  const dotted = new RegExp(`^\\s*${table}\\.${key}\\s*=`);
  for (let i = 0; i < lines.length; i += 1) {
    if (dotted.test(lines[i]) && !HEADER.test(lines[i])) {
      const m = ASSIGNMENT.exec(lines[i]);
      if (!m) return { ok: false, reason: `the line setting ${table}.${key} is not a simple assignment` };
      const [, indent, , eq, rest] = m;
      const { value: current, tail } = splitValue(rest);
      return {
        ok: true,
        changed: unquoted(current) !== value,
        previous: unquoted(current),
        text: lines.map((l, n) => (n === i ? `${indent}${table}.${key}${eq}${literal(value)}${tail}` : l)).join('\n'),
      };
    }
  }

  if (matches.length === 0) {
    const inline = new RegExp(`^\\s*${table}\\s*=\\s*\\{`);
    if (lines.some((l) => inline.test(l))) {
      return { ok: false, reason: `${table} is written as an inline table, which cannot be extended safely` };
    }
  }

  const start = matches.length ? matches[0].line : -1;
  // The body of a table runs until the next header.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (HEADER.test(lines[i])) { end = i; break; }
  }

  for (let i = start + 1; i < end; i += 1) {
    const m = ASSIGNMENT.exec(lines[i]);
    if (!m || m[2] !== key) continue;
    const [, indent, , eq, rest] = m;
    const { value: current, tail } = splitValue(rest);
    return {
      ok: true,
      changed: unquoted(current) !== value,
      previous: unquoted(current),
      text: lines.map((l, n) => (n === i ? `${indent}${key}${eq}${literal(value)}${tail}` : l)).join('\n'),
    };
  }

  // Not set: add it. Inside an existing table it goes at the end of that table's
  // body, so the keys already there stay together.
  const line = `${key} = ${literal(value)}`;
  if (start === -1) {
    const out = [...lines];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push(`[${table}]`, line, '');
    return { ok: true, changed: true, previous: null, text: out.join('\n') };
  }

  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  const out = [...lines];
  out.splice(insertAt, 0, line);
  return { ok: true, changed: true, previous: null, text: out.join('\n') };
}

/** Read a key out of a table, or null. For reporting what is currently set. */
export function getTomlKey(text, table, key) {
  const lines = String(text ?? '').split('\n');
  const inTable = new RegExp(`^\\s*\\[${table}\\]\\s*(#.*)?$`);
  const dotted = new RegExp(`^\\s*${table}\\.${key}\\s*=`);
  let inside = false;
  for (const line of lines) {
    if (dotted.test(line) && !HEADER.test(line)) {
      const m = ASSIGNMENT.exec(line);
      return m ? unquoted(splitValue(m[4]).value) : null;
    }
    if (inTable.test(line)) { inside = true; continue; }
    if (inside && HEADER.test(line)) return null;
    if (!inside) continue;
    const m = ASSIGNMENT.exec(line);
    if (m && m[2] === key) return unquoted(splitValue(m[4]).value);
  }
  return null;
}
