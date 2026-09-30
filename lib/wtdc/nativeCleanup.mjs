// Herdr 0.9.x has no blocking pre-removal event. Its native TUI invokes `git`
// through PATH, so an opt-in Git launcher can clean tracked containers first.
// Ordinary Git commands go straight to the original executable without Node.
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE_DIR, CONFIG_DIR } from "./context.mjs";

const MARKER = "# wtdc-native-git ";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function metadata(file) {
  try {
    const line = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .find((v) => v.startsWith(MARKER));
    return line ? JSON.parse(line.slice(MARKER.length)) : null;
  } catch {
    return null;
  }
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export function realGit() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(dir, "git");
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (!fs.statSync(file).isFile()) continue;
      const original = metadata(file)?.git;
      return original || fs.realpathSync(file);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error("git is not available on PATH");
}

export function installNativeCleanup({
  binDir = path.join(process.env.HOME, ".local/bin"),
  gitBin = realGit(),
} = {}) {
  const file = path.join(binDir, "git");
  if (exists(file) && !metadata(file)) {
    throw new Error(`${file} already exists; refusing to replace an unrelated Git executable`);
  }
  if (path.resolve(gitBin) === path.resolve(file))
    throw new Error("Git launcher would call itself");
  fs.accessSync(gitBin, fs.constants.X_OK);
  const text = `#!/bin/sh
${MARKER}${JSON.stringify({ git: gitBin })}
case " $* " in
  *" worktree remove "*)
    if [ ! -f ${quote(path.join(ROOT, "bin/git.mjs"))} ] || [ ! -x ${quote(process.execPath)} ]; then
      exec ${quote(gitBin)} "$@"
    fi
    export WTDC_REAL_GIT=${quote(gitBin)}
    export HERDR_PLUGIN_ROOT=${quote(ROOT)}
    export HERDR_PLUGIN_STATE_DIR=${quote(STATE_DIR)}
    export HERDR_PLUGIN_CONFIG_DIR=${quote(CONFIG_DIR)}
    exec ${quote(process.execPath)} ${quote(path.join(ROOT, "bin/git.mjs"))} "$@"
    ;;
  *) exec ${quote(gitBin)} "$@" ;;
esac
`;
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o755, flag: "wx" });
  fs.renameSync(tmp, file);
  return file;
}
