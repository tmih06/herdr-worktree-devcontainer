// Agreements between files, which no single-module test can see.
//
// Every other test in this directory drives one module. These read the files that have to
// stay in step with each other — herdr-plugin.toml against the CLI that implements it, the
// image manifest against the workflow that builds it and the config that consumes it, the
// README against all of them — because the failure mode there is silence: renaming an
// action, a template or a setting breaks nothing that a compiler or a unit test looks at,
// and the first report is a user saying the menu item does nothing.
//
// The readers below throw on a shape they do not recognise rather than returning an empty
// list. A check that quietly examines nothing is the thing this file is trying to avoid.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseJsonc } from "../lib/wtdc/jsonc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** The only value shapes herdr-plugin.toml uses: a JSON literal, or a bare scalar. */
function scalar(raw) {
  if (raw.startsWith("[") || raw.startsWith('"')) return JSON.parse(raw);
  return raw;
}

/**
 * herdr-plugin.toml as its list of tables. A value that runs past its line is a hard
 * error, which is the point: a command array reformatted onto several lines must fail
 * here rather than leave the checks below inspecting a table with no command in it.
 */
function pluginTables() {
  const tables = [];
  for (const line of read("herdr-plugin.toml").split("\n")) {
    const header = line.match(/^\[\[([a-z_]+)\]\]\s*$/);
    if (header) {
      tables.push({ name: header[1], keys: {} });
      continue;
    }
    const pair = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
    if (pair && tables.length) tables.at(-1).keys[pair[1]] = scalar(pair[2]);
  }
  return tables;
}

/** The plugin's .mjs sources, which are the ones that ship. */
function shipped() {
  const out = [];
  for (const dir of ["bin", "lib", "panes"]) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
      if (String(entry).endsWith(".mjs")) out.push(`${dir}/${entry}`);
    }
  }
  return out;
}

const manifest = pluginTables();
const table = (name) => manifest.filter((entry) => entry.name === name);
const wtdc = read("bin/wtdc.mjs");
const images = JSON.parse(read("images/manifest.json"));
const specs = images.images;
/** How a template name becomes an image reference, as lib/wtdc/devcontainer.mjs resolves it. */
const imageRef = (name) => `${images.registry}/${images.prefix}-${name}:${images.tag}`;

test("the plugin manifest is one Herdr can load, with the id the code uses", () => {
  const kinds = [...new Set(manifest.map((entry) => entry.name))].sort();
  assert.deepEqual(kinds, ["actions", "events", "panes", "startup"]);
  const header = read("herdr-plugin.toml");
  const id = header.match(/^id = "([^"]+)"$/m)?.[1];
  const name = header.match(/^name = "([^"]+)"$/m)?.[1];
  const minHerdr = header.match(/^min_herdr_version = "([^"]+)"$/m)?.[1];
  assert.ok(id && name && minHerdr, "id, name and min_herdr_version are all declared");

  // The id is what `herdr plugin action invoke <id>.<action>` matches, and three files
  // spell it out. Two spellings would give an action that exists and cannot be invoked.
  const context = read("lib/wtdc/context.mjs");
  assert.equal(context.match(/PLUGIN_ID = "([^"]+)"/)?.[1], id);
  assert.equal(read("lib/wtdc/herdr.mjs").match(/HERDR_PLUGIN_ID \|\| "([^"]+)"/)?.[1], id);
});

test("herdr-plugin.toml points only at files that are here", () => {
  const commands = manifest.map((entry) => entry.keys.command).filter(Boolean);
  assert.ok(commands.length >= 6, `commands parsed: ${commands.length}`);
  for (const command of commands) {
    assert.ok(Array.isArray(command), `command is a list: ${JSON.stringify(command)}`);
    for (const part of command) {
      if (typeof part !== "string") continue;
      const expanded = part.match(/\$HERDR_PLUGIN_ROOT\/([^"\s]+)/);
      const relative = part.match(/^(?:bin|lib|panes)\/[\w./-]+\.mjs$/);
      if (expanded) assert.ok(exists(expanded[1]), `${expanded[1]} is there`);
      else if (relative) assert.ok(exists(part), `${part} is there`);
    }
  }
});

test("each declared action is dispatched under its own name", () => {
  const actions = table("actions");
  assert.ok(actions.length >= 5, `actions parsed: ${actions.length}`);
  const ids = actions.map((entry) => entry.keys.id);
  assert.equal(new Set(ids).size, ids.length, "action ids are unique");

  for (const action of actions) {
    const { id, command } = action.keys;
    // The bug: adding an action by copying its neighbour and editing only the title, so
    // the menu entry runs the other one's behaviour under a new name.
    assert.deepEqual(command.slice(0, 3), ["node", "bin/wtdc.mjs", "action"], id);
    assert.equal(command.at(-1), id, `${id} names itself as the action to run`);
    assert.match(wtdc, new RegExp(`id === "${id}"`), `${id} is dispatched`);
  }
});

test("every hook the manifest registers is a verb bin/wtdc.mjs knows", () => {
  const events = table("events");
  const startups = table("startup");
  assert.ok(events.length >= 2, `events parsed: ${events.length}`);
  assert.equal(startups.length, 1, "one startup hook");

  for (const event of events) {
    assert.equal(typeof event.keys.on, "string", "an event names what it listens for");
    assert.match(read("herdr-plugin.toml"), new RegExp(`on = "${event.keys.on}"`));
  }
  for (const entry of [...events, ...startups]) {
    const verb = entry.keys.command[2];
    assert.equal(entry.keys.command[1], "bin/wtdc.mjs");
    assert.match(wtdc, new RegExp(`case "${verb}":`), `${verb} is dispatched`);
  }
});

test("the panes declared are the panes that are here", () => {
  const declared = new Set();
  for (const pane of table("panes")) {
    const command = pane.keys.command;
    assert.equal(command[0], "sh");
    const found = command.join(" ").match(/\$HERDR_PLUGIN_ROOT\/(panes\/[^"\s]+)/);
    assert.ok(found, `${pane.keys.id} names a script under HERDR_PLUGIN_ROOT`);
    assert.ok(exists(found[1]), `${found[1]} is there`);
    declared.add(found[1]);
  }
  assert.ok(declared.size >= 3, `panes parsed: ${declared.size}`);

  const present = fs
    .readdirSync(path.join(ROOT, "panes"))
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => `panes/${file}`);
  // Both directions: a pane script nothing declares is a screen that can never open, and
  // a declaration with no file is a screen that opens empty.
  assert.deepEqual([...declared].sort(), present.sort());
});

test("every template in images/manifest.json is a directory with a Dockerfile", () => {
  const names = specs.map((spec) => spec.name);
  assert.ok(specs.length >= 2, `templates parsed: ${specs.length}`);
  assert.equal(new Set(names).size, names.length, "template names are unique");
  assert.equal(specs.filter((spec) => spec.base == null).length, 1, "exactly one root template");

  for (const spec of specs) {
    assert.ok(exists(`${spec.dir}/Dockerfile`), `${spec.dir}/Dockerfile is there`);
    // The plan job in images.yml derives every build's ref from the name and the directory,
    // so the two have to be the same word.
    assert.equal(path.basename(spec.dir), spec.name, `${spec.name} lives in its own directory`);
    if (spec.base != null) assert.ok(names.includes(spec.base), `${spec.base} is a template`);
  }
});

test("a template inherits its parent through BASE_IMAGE", () => {
  for (const spec of specs) {
    const dockerfile = read(`${spec.dir}/Dockerfile`);
    const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1] ?? "";
    assert.ok(from, `${spec.name} has a FROM`);
    if (spec.base == null) {
      // The root is the one that names a real tag; a BASE_IMAGE there would be an argument
      // nobody passes, and an empty FROM.
      assert.doesNotMatch(dockerfile, /BASE_IMAGE/);
      continue;
    }
    // images.yml passes BASE_IMAGE=<the tag built this run>, and a child build that ignored
    // it would silently test against whatever the parent's tag held before the run. The
    // default is the parent's published tag, spelled from the manifest rather than typed
    // out again, so the registry and prefix live in one file.
    assert.equal(
      dockerfile.match(/^ARG BASE_IMAGE=(.+)$/m)?.[1],
      imageRef(spec.base),
      `${spec.name} declares ARG BASE_IMAGE`,
    );
    assert.match(from, /^\$\{?BASE_IMAGE\}?$/, `${spec.name} is FROM ${from}`);
  }
});

test("the manifest's platforms are the ones the image workflow builds", () => {
  const declared = images.platforms;
  assert.ok(Array.isArray(declared) && declared.length >= 1);
  const built = read(".github/workflows/images.yml").match(/^\s*PLATFORMS:\s*(.+)$/m)?.[1];
  assert.ok(built, "images.yml declares PLATFORMS");
  assert.deepEqual(
    built.split(",").map((platform) => platform.trim()),
    declared,
  );
});

test("this repo's own devcontainer names a template that is published, and stays on the fast path", () => {
  const config = parseJsonc(read(".devcontainer/devcontainer.json"));
  assert.ok(
    specs.some((spec) => imageRef(spec.name) === config.image),
    `${config.image} is a template in the manifest`,
  );
  // A config that declares `features` makes the Dev Container CLI derive a per-workspace
  // image, so every worktree of this repo pays a build before it can start. The file says
  // so; this is what keeps it true.
  assert.equal(config.features, undefined, "no features, so `up` is a docker run");
});

test("README documents every action, under the plugin id the manifest declares", () => {
  const readme = read("README.md");
  const ids = table("actions").map((entry) => entry.keys.id);
  for (const id of ids) assert.ok(readme.includes(id), `README mentions ${id}`);

  const pluginId = read("lib/wtdc/context.mjs").match(/PLUGIN_ID = "([^"]+)"/)[1];
  const invocations = [...readme.matchAll(/herdr plugin action invoke (\S+?)\.(\S+)/g)];
  assert.ok(invocations.length >= 2, `invocations parsed: ${invocations.length}`);
  for (const [, named, action] of invocations) {
    assert.equal(named, pluginId, "the invocation names this plugin");
    assert.ok(ids.includes(action), `${action} is a declared action`);
  }
  for (const [, named] of readme.matchAll(/herdr plugin enable (\S+)/g)) {
    assert.equal(named, pluginId);
  }
});

test("README's relative links point at files that are here", () => {
  let links = 0;
  for (const file of ["README.md", "images/README.md"]) {
    const dir = path.dirname(file);
    for (const [, target] of read(file).matchAll(/\]\(([^)\s#]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, and friends
      links += 1;
      assert.ok(exists(path.join(dir, target)), `${file} links to ${target}`);
    }
  }
  assert.ok(links >= 1, "relative links were parsed");
});

test("the plugin imports nothing outside itself and node", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies to install");

  const sources = shipped();
  assert.ok(sources.length >= 15, `sources parsed: ${sources.length}`);
  let imports = 0;
  for (const file of sources) {
    for (const [, spec] of read(file).matchAll(/(?:from\s+|import\s*\(?\s*)"([^"]+)"/g)) {
      imports += 1;
      assert.ok(
        spec.startsWith(".") || spec.startsWith("node:"),
        `${file} imports ${spec}, which is not installed by anything`,
      );
    }
  }
  assert.ok(imports >= 15, `imports parsed: ${imports}`);
});

test("every setting in config.default.env is read by the plugin", () => {
  const settings = read("config/config.default.env")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  assert.ok(settings.length >= 5, `settings parsed: ${settings.length}`);
  // A key Herdr copies into the user's config.env is read as `KEY=value`; a line with a
  // space around the `=` is not a setting, and would be silently dropped by the parser.
  for (const line of settings) assert.match(line, /^[A-Z][A-Z0-9_]*=/, `not a setting: ${line}`);

  const source = shipped()
    .map((file) => read(file))
    .join("\n");
  for (const line of settings) {
    const key = line.slice(0, line.indexOf("="));
    // The name is the whole interface: a setting renamed here and not in the code is a
    // switch that does nothing, and a user who edited it has no way to tell.
    assert.ok(source.includes(key), `${key} is read somewhere`);
  }
});
