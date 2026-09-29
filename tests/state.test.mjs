import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as state from "../lib/wtdc/state.mjs";

test("state treats a non-object entries field as corrupt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-state-"));
  const file = path.join(dir, "state.json");
  const previous = process.env.WTDC_STATE_FILE;
  process.env.WTDC_STATE_FILE = file;

  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: "broken" }));
    assert.deepEqual(state.list(), []);
    assert.equal(state.get("/worktree"), null);
  } finally {
    if (previous === undefined) delete process.env.WTDC_STATE_FILE;
    else process.env.WTDC_STATE_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
