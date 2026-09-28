// JSONC support.
//
// devcontainer.json is JSONC: it routinely carries comments, and `//` appears
// inside string values all the time (URLs, globs). A regex cannot tell those
// apart, so this is a character scanner that copies string literals verbatim.
//
// This used to be a separate `bin/jsonc2json.js` shelled out to from bash,
// which meant a subprocess on the provisioning path and JSON logic split across
// two languages. Folding it in removes both.

/** Remove `//` and `/* *\/` comments, leaving string contents untouched. */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === c) { i += 1; break; }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }

    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Remove commas that sit immediately before a closing brace or bracket. */
export function stripTrailingCommas(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === c) { i += 1; break; }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') {
        i += 1;
        continue;
      }
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Parse JSONC text into a value. Throws on genuinely invalid JSON. */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}
