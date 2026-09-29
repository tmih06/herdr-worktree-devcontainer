import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("plugin config fallback follows XDG_CONFIG_HOME", () => {
  const configHome = path.join(os.tmpdir(), "wtdc-xdg-config");
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { CONFIG_DIR } from './lib/wtdc/context.mjs'; console.log(CONFIG_DIR)",
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: "",
        XDG_CONFIG_HOME: configHome,
        HDG_CONFIG_HOME: path.join(os.tmpdir(), "wrong-config-home"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    res.stdout.trim(),
    path.join(configHome, "herdr", "plugins", "config", "worktree-devcontainer"),
  );
});
