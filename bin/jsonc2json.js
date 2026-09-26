#!/usr/bin/env node
// Strip JSONC comments so jq can read a devcontainer.json.
//
// devcontainer.json is JSONC and routinely contains comments, sometimes with
// "//" inside string values (URLs). This is a character scanner rather than a
// regex, so strings are never touched.
//
//   node bin/jsonc2json.js <in.jsonc> [out.json]

const fs = require('node:fs');

function stripJsonComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === '"') {
      // Copy the string literal verbatim, honouring backslash escapes.
      out += c;
      i += 1;
      while (i < n) {
        out += text[i];
        if (text[i] === '\\') {
          // Keep the escaped character with its backslash.
          if (i + 1 < n) out += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
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

function stripTrailingCommas(text) {
  // Only legal where a value may end: before } or ]. Done with a scanner so
  // commas inside strings survive.
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i += 1;
      while (i < n) {
        out += text[i];
        if (text[i] === '\\') {
          if (i + 1 < n) out += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
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

const [input, output] = process.argv.slice(2);
if (!input) {
  process.stderr.write('usage: jsonc2json.js <in.jsonc> [out.json]\n');
  process.exit(2);
}

const raw = fs.readFileSync(input, 'utf8');
const json = stripTrailingCommas(stripJsonComments(raw));

try {
  JSON.parse(json);
} catch (err) {
  process.stderr.write(`jsonc2json: ${input} is not parseable after comment removal: ${err.message}\n`);
  process.exit(1);
}

if (output) fs.writeFileSync(output, json);
else process.stdout.write(json);
