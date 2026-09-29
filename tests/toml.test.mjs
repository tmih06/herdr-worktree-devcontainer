import assert from "node:assert/strict";
import test from "node:test";

import { getTomlKey, setTomlKey } from "../lib/wtdc/toml.mjs";

const shell = "/plugin/lib/wtdc/shell.mjs";

test("TOML editor does not treat a nested dotted key as a root key", () => {
  const source = '[server]\nterminal.default_shell = "server-setting"\n';

  assert.equal(getTomlKey(source, "terminal", "default_shell"), null);
  const result = setTomlKey(source, "terminal", "default_shell", shell);

  assert.equal(result.ok, true);
  assert.match(result.text, /terminal\.default_shell = "server-setting"/);
  assert.match(result.text, /\[terminal\]\ndefault_shell =/);
  assert.equal(getTomlKey(result.text, "terminal", "default_shell"), shell);
});

test("TOML editor reads and replaces a root dotted key", () => {
  const result = setTomlKey(
    'terminal.default_shell = "/bin/sh"\n',
    "terminal",
    "default_shell",
    shell,
  );

  assert.equal(result.ok, true);
  assert.equal(result.previous, "/bin/sh");
  assert.equal(result.text, `terminal.default_shell = "${shell}"\n`);
  assert.equal(getTomlKey(result.text, "terminal", "default_shell"), shell);
});

test("TOML editor recognizes indented table headers", () => {
  const source = '[server]\nport = 8080\n  [terminal] # user settings\nshell_mode = "auto"\n';

  const result = setTomlKey(source, "terminal", "default_shell", shell);

  assert.equal(result.ok, true);
  assert.match(
    result.text,
    / {2}\[terminal\] # user settings\nshell_mode = "auto"\ndefault_shell =/,
  );
  assert.equal(getTomlKey(result.text, "terminal", "default_shell"), shell);
  assert.equal(getTomlKey(result.text, "server", "port"), "8080");
});
