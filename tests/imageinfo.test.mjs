import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("image lookup command runs when invoked through a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtdc-imageinfo-"));
  try {
    const alias = path.join(dir, "imageInfo.mjs");
    fs.symlinkSync(path.resolve(import.meta.dirname, "../lib/wtdc/imageInfo.mjs"), alias);
    const result = spawnSync(process.execPath, [alias], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ref: "", state: "unknown", size: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
