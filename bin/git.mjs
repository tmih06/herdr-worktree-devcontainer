#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_STATE_FILE, ROOT } from "../lib/wtdc/context.mjs";
import { loadConfig } from "../lib/wtdc/config.mjs";

const gitBin = process.env.WTDC_REAL_GIT || "/usr/bin/git";
const args = process.argv.slice(2);
const git = (argv, stdio = "pipe") => spawnSync(gitBin, argv, { stdio, encoding: "utf8" });
const passThrough = () => process.exit(git(args, "inherit").status ?? 1);

// Match Git's command position, never a substring in a commit message or path.
function removal() {
  let cwd = process.cwd();
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const flag = args[index++];
    if (flag === "-C") cwd = path.resolve(cwd, args[index++] || ".");
    else if (flag === "-c") index += 1;
    else return null;
  }
  if (args[index++] !== "worktree" || args[index++] !== "remove") return null;
  let force = false;
  if (["-f", "--force"].includes(args[index])) {
    force = true;
    index += 1;
  }
  if (args[index] === "--") index += 1;
  if (!args[index] || index + 1 !== args.length || args[index].startsWith("-")) return null;
  return { cwd, checkout: path.resolve(cwd, args[index]), force };
}

function ownedDirectoriesWritable(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  if (stat.uid === process.getuid() && (stat.mode & 0o700) !== 0o700) {
    fs.chmodSync(directory, (stat.mode & 0o7777) | 0o700);
  }
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name);
    const childStat = fs.lstatSync(child);
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) ownedDirectoriesWritable(child);
  }
}

function main() {
  const target = removal();
  if (!target || loadConfig().WTDC_ENABLED !== "1") return passThrough();
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(process.env.WTDC_STATE_FILE || DEFAULT_STATE_FILE, "utf8"))
      .entries?.[target.checkout];
  } catch {
    return passThrough();
  }
  if (!entry) return passThrough();

  // A linked worktree's .git is a file. Main checkouts and replacement symlinks
  // must never be reclaimed as leftovers, even when stale plugin state exists.
  let original;
  try {
    original = fs.lstatSync(target.checkout);
    if (!original.isDirectory() || !fs.lstatSync(path.join(target.checkout, ".git")).isFile()) {
      return passThrough();
    }
  } catch {
    return passThrough();
  }
  if (!target.force) {
    const status = git(["-C", target.checkout, "status", "--porcelain"]);
    // Let Git produce its normal dirty/locked/trust errors without touching Docker.
    if (status.status !== 0 || status.stdout.trim()) return passThrough();
  }
  const cleanup = spawnSync(
    process.execPath,
    [path.join(ROOT, "bin/wtdc.mjs"), "teardown", target.checkout],
    {
      stdio: "inherit",
    },
  );
  if (cleanup.status !== 0) process.exit(cleanup.status ?? 1);

  const result = git(args);
  if (result.status !== 0 && !fs.existsSync(path.join(target.checkout, ".git"))) {
    // Git can unregister the worktree before reporting failed directory deletion.
    // Finish only this explicitly requested checkout, if its identity still matches
    // and a successful Git query proves it is no longer registered.
    const registered = git(["-C", target.cwd, "worktree", "list", "--porcelain", "-z"]);
    const paths = registered.stdout
      ?.split("\0")
      .filter((v) => v.startsWith("worktree "))
      .map((v) => v.slice(9));
    if (registered.status === 0 && !paths.includes(target.checkout)) {
      if (fs.existsSync(target.checkout)) {
        const remaining = fs.lstatSync(target.checkout);
        if (
          remaining.ino !== original.ino ||
          remaining.dev !== original.dev ||
          !remaining.isDirectory()
        ) {
          throw new Error(
            "checkout was replaced during removal; refusing to delete its replacement",
          );
        }
        ownedDirectoriesWritable(target.checkout);
        fs.rmSync(target.checkout, { recursive: true, force: true });
      }
      process.exit(0);
    }
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}

try {
  main();
} catch (err) {
  process.stderr.write(`worktree-devcontainer: ${err.message}\n`);
  process.exit(1);
}
