// Unit tests for the pure logic.
//
// These are the parts that used to be untestable in bash: the JSONC scanner, the
// config parser, the merged-config transform, and the cwd-to-container mapping
// the shell dispatcher runs on every new pane. None of them need docker, a
// devcontainer CLI, or a Herdr server.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stripComments, stripTrailingCommas, parseJsonc } from '../lib/wtdc/jsonc.mjs';
import { parseEnvFile } from '../lib/wtdc/config.mjs';
import { findByCwd, set, del, get, patch } from '../lib/wtdc/state.mjs';
import { gitDirMount, buildMerged, branchHostname } from '../lib/wtdc/devcontainer.mjs';

// Scratch directories, removed when the file finishes. Without the cleanup every run
// leaves one behind per test, which turns /tmp into a few hundred stale directories
// after a day of work — and a leaked directory is indistinguishable from a real one
// when something goes looking for its state.
const scratch = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdc-test-'));
  scratch.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- jsonc

test('jsonc: strips line comments but keeps // inside strings', () => {
  const out = stripComments('{ "url": "https://example.com", // trailing\n "a": 1 }');
  assert.match(out, /"url": "https:\/\/example\.com"/);
  assert.doesNotMatch(out, /trailing/);
});

test('jsonc: strips block comments', () => {
  assert.equal(stripComments('{ /* hi */ "a": 1 }').trim(), '{  "a": 1 }');
});

test('jsonc: a comment marker inside a block comment does not end it early', () => {
  assert.equal(stripComments('{ /* // not the end */ "a": 1 }').includes('not the end'), false);
});

test('jsonc: keeps escaped quotes intact', () => {
  const src = '{ "a": "say \\"hi\\" // now" }';
  assert.match(stripComments(src), /say \\"hi\\" \/\/ now/);
});

test('jsonc: strips trailing commas only before a closing bracket', () => {
  assert.equal(stripTrailingCommas('[1, 2, ]'), '[1, 2 ]');
  assert.equal(stripTrailingCommas('{"a": 1,}'), '{"a": 1}');
  // A comma inside a string is not a trailing comma.
  assert.match(stripTrailingCommas('{"a": "x, ]"}'), /"x, \]"/);
});

test('jsonc: parses a realistic devcontainer.json', () => {
  const doc = parseJsonc(`{
    // the image
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": { "ghcr.io/devcontainers/features/node:1": {} },
    "postCreateCommand": "echo ready",
  }`);
  assert.equal(doc.image, 'mcr.microsoft.com/devcontainers/base:ubuntu');
  assert.equal(doc.postCreateCommand, 'echo ready');
});

// ------------------------------------------------------------------ config

test('config: parses bare, quoted, and commented values', () => {
  const parsed = parseEnvFile([
    'WTDC_ENABLED=1',
    "WTDC_CONTAINER_ICON='\u{1F433}'",
    'WTDC_CONFIG_CANDIDATES=\'.devcontainer/devcontainer.json .devcontainer.json\'',
    'WTDC_IMAGE=  spaced  ',
    '# a comment',
    'WTDC_NOTIFY=0 # trailing comment',
  ].join('\n'));

  assert.equal(parsed.WTDC_ENABLED, '1');
  assert.equal(parsed.WTDC_CONTAINER_ICON, '\u{1F433}');
  assert.equal(parsed.WTDC_CONFIG_CANDIDATES, '.devcontainer/devcontainer.json .devcontainer.json');
  assert.equal(parsed.WTDC_IMAGE, 'spaced');
  assert.equal(parsed.WTDC_NOTIFY, '0');
});

test('config: a # inside quotes is not a comment', () => {
  assert.equal(parseEnvFile('A=\'x # y\'').A, 'x # y');
});

// ------------------------------------------------------------------- state

test('state: round-trips an entry and finds it by cwd', () => {
  const dir = tmp();
  process.env.WTDC_STATE_FILE = path.join(dir, 'state.json');

  set('/w/feat', { label: 'feat', container_id: 'abc', checkout_path: '/w/feat' });

  assert.equal(get('/w/feat').container_id, 'abc');
  assert.equal(findByCwd('/w/feat').container_id, 'abc');
  assert.equal(findByCwd('/w/feat/src/deep').container_id, 'abc', 'a subdirectory must match');
  assert.equal(findByCwd('/w/feature'), null, 'a prefix that is not a path boundary must not match');
  assert.equal(findByCwd('/other'), null);

  patch('/w/feat', { container_id: 'xyz' });
  assert.equal(get('/w/feat').container_id, 'xyz');

  del('/w/feat');
  assert.equal(get('/w/feat'), null);
});

test('state: the longest matching checkout wins', () => {
  const dir = tmp();
  process.env.WTDC_STATE_FILE = path.join(dir, 'state.json');
  set('/w', { checkout_path: '/w', container_id: 'parent' });
  set('/w/nested', { checkout_path: '/w/nested', container_id: 'child' });

  assert.equal(findByCwd('/w/nested').container_id, 'child');
  assert.equal(findByCwd('/w/other').container_id, 'parent');
});

test('state: corrupt state is treated as empty rather than crashing', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ this is not json');
  process.env.WTDC_STATE_FILE = file;
  assert.equal(get('/anything'), null);
});

// ------------------------------------------------------------- git dir mount

function makeRepo({ linked = true } = {}) {
  const dir = tmp();
  const main = path.join(dir, 'main');
  fs.mkdirSync(main);
  const git = (args, cwd = main) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(main, 'a.txt'), 'hi');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);

  if (!linked) return { main, worktree: main };
  const worktree = path.join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'feat', worktree]);
  return { main, worktree };
}

test('gitDirMount: a linked worktree gets its shared git dir mounted at the host path', () => {
  const { main, worktree } = makeRepo();
  const mount = gitDirMount(worktree);
  assert.equal(mount, `type=bind,source=${main}/.git,target=${main}/.git`);
});

test('gitDirMount: a main checkout needs no extra mount', () => {
  const { main } = makeRepo({ linked: false });
  assert.equal(gitDirMount(main), null);
});

test('gitDirMount: a directory that is not a repo yields nothing', () => {
  assert.equal(gitDirMount(tmp()), null);
});

// ---------------------------------------------------------------- merged config

test('buildMerged: appends the readiness marker and preserves the repo config', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(src, `{
    // a comment
    "image": "debian:12",
    "features": { "ghcr.io/devcontainers/features/node:1": {} },
    "runArgs": ["--init"],
    "postCreateCommand": "echo upstream-ok"
  }`);

  buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' });
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));

  assert.equal(merged.image, 'debian:12', 'image must be untouched');
  assert.deepEqual(merged.features, { 'ghcr.io/devcontainers/features/node:1': {} },
    'user features must survive: nothing is injected any more');
  assert.deepEqual(merged.runArgs, ['--init'], 'no port is published any more');
  assert.match(merged.postCreateCommand, /^echo upstream-ok && id -un > \/tmp\/wtdc-user$/);
});

test('buildMerged: an array postCreateCommand is chained, not joined with spaces', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(src, '{ "postCreateCommand": ["apt-get update", "make dev"] }');

  buildMerged(src, out, {});
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
  // The CLI execs the joined string as one line, so a space join would silently
  // run only the first command.
  assert.equal(merged.postCreateCommand, 'apt-get update && make dev && id -un > /tmp/wtdc-user');
});

test('buildMerged: names the container after its branch, through runArgs', () => {
  // The hostname is what the prompt shows after the @, and it is fixed when the
  // container is created, so it has to reach `docker run` as a flag. runArgs is the one
  // place the CLI passes extra flags straight through.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  const wt = makeRepo().worktree;
  fs.writeFileSync(src, '{ "image": "debian:12", "runArgs": ["--init"] }');

  buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, wt);
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));

  assert.ok(merged.runArgs.includes('--hostname'), 'a --hostname flag is added');
  const hostname = merged.runArgs[merged.runArgs.indexOf('--hostname') + 1];
  assert.equal(hostname, 'feat', 'the worktree is on the branch makeRepo checked it out on');
  assert.ok(merged.runArgs.includes('--init'), 'existing runArgs survive');
});

test('buildMerged: a --hostname in the repo\'s own runArgs is never overridden', () => {
  // The repo is authoritative about its container, the same way it is about its image.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  const wt = makeRepo().worktree;

  for (const declared of [['--hostname', 'chosen-by-the-repo'], ['--hostname=also-chosen']]) {
    fs.writeFileSync(src, JSON.stringify({ image: 'debian:12', runArgs: declared }));
    buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, wt);
    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(merged.runArgs, declared, `runArgs ${JSON.stringify(declared)} must be left alone`);
  }
});

test('buildMerged: WTDC_HOSTNAME=off leaves the prompt showing the container id', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(src, '{ "image": "debian:12" }');

  buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '', WTDC_HOSTNAME: 'off' }, makeRepo().worktree);
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(merged.runArgs, undefined, 'no runArgs are invented');
});

test('buildMerged: a config with no runArgs at all gets a table for it', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(src, '{ "image": "debian:12" }');

  // makeRepo's linked worktree is checked out on `feat`, not `wt`.
  buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, makeRepo().worktree);
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(Array.isArray(merged.runArgs), 'runArgs has to exist to be appended to');
  assert.deepEqual(merged.runArgs, ['--hostname', 'feat']);
});

test('buildMerged: a literal WTDC_HOSTNAME is used as given', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(src, '{ "image": "debian:12" }');

  buildMerged(src, out, { WTDC_IMAGE: '', WTDC_TEMPLATE: '', WTDC_HOSTNAME: 'my-box' }, makeRepo().worktree);
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(merged.runArgs, ['--hostname', 'my-box']);
});

test('branchHostname: branch names are folded into something a container may be called', () => {
  // The name is read in a prompt and typed into docker commands, so it has to be a legal
  // DNS label: letters, digits and hyphens, at most 63, no leading or trailing hyphen.
  assert.equal(branchHostname('feature123'), 'feature123');
  assert.equal(branchHostname('feat/payments'), 'feat-payments');
  assert.equal(branchHostname('Fix_Thing'), 'fix-thing');
  assert.equal(branchHostname('  spaced  '), 'spaced');
  assert.equal(branchHostname('a--b'), 'a-b', 'runs of hyphens collapse');
  assert.equal(branchHostname('-lead-and-trail-'), 'lead-and-trail');
  assert.equal(branchHostname('x'.repeat(200)).length, 63, 'and it is capped');
  assert.equal(branchHostname('x'.repeat(70) + '-trailing'), 'x'.repeat(63), 'the cap does not leave a trailing hyphen');
  assert.match(branchHostname('123'), /^wt-/, 'an all-digits label would read like an address');
  assert.match(branchHostname(''), /^wt/, 'and an empty one is not a hostname');
  assert.match(branchHostname('///'), /^wt$/);
});

test('buildMerged: object-form postCreateCommand is rejected, not reshaped', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, '{ "postCreateCommand": { "server": "make dev" } }');
  assert.throws(
    () => buildMerged(src, path.join(dir, 'out.json'), {}),
    /object-form postCreateCommand/,
  );
});

test('buildMerged: the checkout is never written to', () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  const original = '{ "image": "debian:12" }';
  fs.writeFileSync(src, original);
  buildMerged(src, path.join(dir, 'out.json'), {});
  assert.equal(fs.readFileSync(src, 'utf8'), original);
});

// ------------------------------------------------------------- plugin manifest

test('the title boot-launch waits for is the one the manifest declares', async () => {
  // bootLaunch recognises the prompt overlay by its pane title, and herdr-plugin.toml is
  // where that title actually comes from. Renaming one without the other means the
  // launcher waits out its full timeout on every worktree, which is slow and silent.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { PROMPT_PANE_TITLE } = await import('../lib/wtdc/herdr.mjs');
  const manifest = fs.readFileSync(path.join(ROOT, 'herdr-plugin.toml'), 'utf8');
  const block = manifest.split('[[panes]]').find((b) => b.includes('id = "prompt"'));
  assert.ok(block, 'the prompt entrypoint must be declared');
  assert.ok(block.includes(`title = "${PROMPT_PANE_TITLE}"`),
    `the manifest and PROMPT_PANE_TITLE disagree about the prompt's title`);
});

// ------------------------------------------------------------- image information

test('compareImage: only a matching digest means up to date', async () => {
  // The failure this guards is the reassuring one: an unknown registry answering
  // "up to date" is worse than saying nothing, because the user acts on it.
  const { compareImage } = await import('../lib/wtdc/imageInfo.mjs');
  const same = { digest: 'sha256:aaa' };
  const other = { digest: 'sha256:bbb' };

  assert.equal(compareImage(null, { digest: 'sha256:aaa' }), 'absent');
  assert.equal(compareImage(same, { digest: 'sha256:aaa' }), 'up-to-date');
  assert.equal(compareImage(same, other), 'update-available');
  assert.equal(compareImage(same, null), 'unknown', 'an unreachable registry is not an up-to-date image');
  assert.equal(compareImage({ digest: '' }, { digest: 'sha256:aaa' }), 'unknown',
    'an image built locally has no digest to compare, which is not the same as current');
});

test('formatSize: sizes a pull, which are large, without lying about small ones', async () => {
  const { formatSize } = await import('../lib/wtdc/imageInfo.mjs');
  assert.equal(formatSize(0), '', 'no size is better than a rounded-up wrong one');
  assert.equal(formatSize(512 * 1024), '512 KB');
  assert.equal(formatSize(105 * 1024 * 1024), '105 MB');
  assert.equal(formatSize(1.5 * 1024 * 1024 * 1024), '1.5 GB');
});

// ------------------------------------------------------------------ what will run

test('planProvision: describes the build without doing it', async () => {
  // The prompt shows this plan, so a plan that is not the plan provisioning runs is a
  // prompt nobody should believe.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, `{
    "image": "debian:12",
    "features": { "ghcr.io/devcontainers/features/node:1": {} },
    "postCreateCommand": "echo hi"
  }`);

  const { planProvision } = await import('../lib/wtdc/devcontainer.mjs');
  const plan = planProvision(src, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, dir);

  assert.equal(plan.image, 'debian:12', 'the declared image is what runs');
  assert.equal(plan.imageSource, 'devcontainer.json');
  assert.equal(plan.buildsImage, true, 'a feature is what makes the CLI derive an image');
  assert.deepEqual(plan.keptFeatures, ['ghcr.io/devcontainers/features/node:1']);
  assert.deepEqual(plan.droppedFeatures, []);
  assert.match(plan.merged.postCreateCommand, /^echo hi && id -un > \/tmp\/wtdc-user$/);

  // And it wrote nothing: the merged config is only ever written by buildMerged.
  assert.deepEqual(fs.readdirSync(dir), ['devcontainer.json']);
});

test('planProvision: a config with no features builds nothing, template or not', async () => {
  // This is the case that made the old warning wrong. "no prebuilt image configured" was
  // true for every provision once WTDC_TEMPLATE defaulted to blank, including all of
  // these — which are a docker run, not a build.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, '{ "image": "ghcr.io/tmih06/herdr-devcontainer-node:latest" }');

  const { planProvision } = await import('../lib/wtdc/devcontainer.mjs');
  for (const config of [
    { WTDC_IMAGE: '', WTDC_TEMPLATE: '' },
    { WTDC_IMAGE: '', WTDC_TEMPLATE: 'base' },
  ]) {
    const plan = planProvision(src, config, dir);
    assert.equal(plan.buildsImage, false, `with ${JSON.stringify(config)}`);
    assert.deepEqual(plan.keptFeatures, []);
  }
});

test('planProvision: a template replaces the image and says which features it drops', async () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, `{
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": { "ghcr.io/devcontainers/features/node:1": {} }
  }`);

  const { planProvision, prebuiltImage } = await import('../lib/wtdc/devcontainer.mjs');
  const plan = planProvision(src, { WTDC_IMAGE: '', WTDC_TEMPLATE: 'base', WTDC_IMAGE_REMOTE_USER: 'dev' }, dir);

  assert.equal(plan.image, prebuiltImage({ WTDC_TEMPLATE: 'base' }), 'the template wins');
  assert.equal(plan.imageSource, 'WTDC_TEMPLATE', 'and the prompt can say where it came from');
  assert.deepEqual(plan.droppedFeatures, ['ghcr.io/devcontainers/features/node:1']);
  assert.equal(plan.buildsImage, false, 'no features survive, so there is nothing to build');
  assert.equal(plan.remoteUser, 'dev');
});

test('planProvision: an image typed in the prompt wins, and keeps the features', async () => {
  // A template replaces the image *and* drops the features, because that is what asking
  // for a template means. Typing an image is not asking for a template: someone who
  // swaps the base image still wants the features applied to it.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, `{
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": { "ghcr.io/devcontainers/features/node:1": {} }
  }`);

  const { planProvision } = await import('../lib/wtdc/devcontainer.mjs');
  const saved = process.env.WTDC_OVERRIDE_IMAGE;
  process.env.WTDC_OVERRIDE_IMAGE = 'ghcr.io/example/typed:1';
  try {
    // A template in the config as well, because that is the case that has to be right: the
    // typed image wins, and nothing is dropped.
    const plan = planProvision(src, { WTDC_IMAGE: '', WTDC_TEMPLATE: 'base' }, dir);
    assert.equal(plan.image, 'ghcr.io/example/typed:1', 'the typed image is what runs');
    assert.equal(plan.imageSource, 'edited in the prompt');
    assert.deepEqual(plan.keptFeatures, ['ghcr.io/devcontainers/features/node:1'], 'the features still apply');
    assert.deepEqual(plan.droppedFeatures, [], 'and none of them are reported as dropped');
    assert.equal(plan.buildsImage, true, 'which is what keeping them costs');
  } finally {
    if (saved === undefined) delete process.env.WTDC_OVERRIDE_IMAGE;
    else process.env.WTDC_OVERRIDE_IMAGE = saved;
  }
});

test('planProvision: an untouched field leaves the config\'s own image alone', async () => {
  // The field is a placeholder, so the common case has to be indistinguishable from
  // there being no field at all.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, '{ "image": "debian:12" }');

  const { planProvision } = await import('../lib/wtdc/devcontainer.mjs');
  const plan = planProvision(src, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, dir);
  assert.equal(plan.image, 'debian:12');
  assert.equal(plan.imageSource, 'devcontainer.json');
});

test('planProvision: the hostname it will set is the one it reports', async () => {
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, '{ "image": "debian:12" }');

  const { planProvision } = await import('../lib/wtdc/devcontainer.mjs');
  const plan = planProvision(src, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, dir);
  assert.ok(plan.hostname, 'a branch-shaped worktree still yields a legal label');
  assert.ok(plan.merged.runArgs.includes(plan.hostname));
});

test('planProvision: a --hostname in the config is reported as none of ours', async () => {
  // The prompt must not claim a hostname the container will not have.
  const dir = tmp();
  const src = path.join(dir, 'devcontainer.json');
  fs.writeFileSync(src, '{ "image": "debian:12", "runArgs": ["--hostname", "chosen"] }');

  const { planProvision } = await import('../lib/wtdc/devcontainer.mjs');
  const plan = planProvision(src, { WTDC_IMAGE: '', WTDC_TEMPLATE: '' }, dir);
  assert.equal(plan.hostname, '');
  assert.deepEqual(plan.merged.runArgs, ['--hostname', 'chosen']);
});

// ----------------------------------------------------------------- config.toml

// `terminal.default_shell` is the whole integration between this plugin and Herdr's pane
// spawning, and the install action edits a file the user owns. So the editor has to leave
// every other setting, comment and quoting style exactly as it found them.

const SHELL = '/plugin/lib/wtdc/shell.mjs';

test('setTomlKey: adds the table when the file has none', async () => {
  const { setTomlKey, getTomlKey } = await import('../lib/wtdc/toml.mjs');
  const edit = setTomlKey('onboarding = false\n[server]\nport = 1\n', 'terminal', 'default_shell', SHELL);

  assert.equal(edit.ok, true);
  assert.equal(edit.previous, null);
  assert.equal(edit.changed, true);
  assert.match(edit.text, /onboarding = false/);
  assert.match(edit.text, /\[server\]\nport = 1/);
  assert.equal(getTomlKey(edit.text, 'terminal', 'default_shell'), SHELL);
});

test('setTomlKey: adds the key to a table that is already there, keeping its other keys', async () => {
  const { setTomlKey, getTomlKey } = await import('../lib/wtdc/toml.mjs');
  const edit = setTomlKey('[terminal]\nshell_mode = "auto"\n\n[server]\nport = 1\n', 'terminal', 'default_shell', SHELL);

  assert.equal(edit.changed, true);
  assert.match(edit.text, /shell_mode = "auto"/, 'an unrelated key in the same table must survive');
  assert.equal(getTomlKey(edit.text, 'terminal', 'default_shell'), SHELL);
  assert.equal(getTomlKey(edit.text, 'server', 'port'), '1');
});

test('setTomlKey: replaces the value in place and keeps the comment', async () => {
  const { setTomlKey, getTomlKey } = await import('../lib/wtdc/toml.mjs');
  const edit = setTomlKey('[terminal]\ndefault_shell = "/usr/bin/fish"  # my shell\n', 'terminal', 'default_shell', SHELL);

  assert.equal(edit.previous, '/usr/bin/fish', 'what was there before has to be reportable');
  assert.equal(edit.text, `[terminal]\ndefault_shell = "${SHELL}"  # my shell\n`);
  assert.equal(getTomlKey(edit.text, 'terminal', 'default_shell'), SHELL);
});

test('setTomlKey: a # inside the value is a value, not a comment', async () => {
  const { setTomlKey, getTomlKey } = await import('../lib/wtdc/toml.mjs');
  const edit = setTomlKey('[terminal]\ndefault_shell = "/bin/sh # not a comment"\n', 'terminal', 'default_shell', SHELL);
  assert.equal(getTomlKey(edit.text, 'terminal', 'default_shell'), SHELL);
});

test('setTomlKey: a dotted key is the same key, rewritten where it is', async () => {
  // `terminal.default_shell = "…"` at the top level would collide with a [terminal]
  // table added alongside it, so it has to be replaced in place instead.
  const { setTomlKey, getTomlKey } = await import('../lib/wtdc/toml.mjs');
  const edit = setTomlKey('terminal.default_shell = "/bin/bash"\n', 'terminal', 'default_shell', SHELL);
  assert.equal(edit.text, `terminal.default_shell = "${SHELL}"\n`);
  assert.doesNotMatch(edit.text, /\[terminal\]/, 'a second way of saying the same key is not added');
  assert.equal(getTomlKey(edit.text, 'terminal', 'default_shell'), SHELL);
});

test('setTomlKey: single-quoted and indented values are still recognised', async () => {
  const { setTomlKey, getTomlKey } = await import('../lib/wtdc/toml.mjs');
  for (const text of ["[terminal]\ndefault_shell = '/bin/sh'\n", '[terminal]\n  default_shell = "/bin/zsh"\n']) {
    const edit = setTomlKey(text, 'terminal', 'default_shell', SHELL);
    assert.equal(edit.changed, true, text);
    assert.equal(getTomlKey(edit.text, 'terminal', 'default_shell'), SHELL, text);
  }
});

test('setTomlKey: setting it twice changes nothing the second time', async () => {
  // The install action is meant to be run whenever, so running it twice must not keep
  // appending or start reporting a change that is not one.
  const { setTomlKey } = await import('../lib/wtdc/toml.mjs');
  const once = setTomlKey('onboarding = false\n', 'terminal', 'default_shell', SHELL);
  const twice = setTomlKey(once.text, 'terminal', 'default_shell', SHELL);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
  assert.equal(twice.previous, SHELL);
});

test('setTomlKey: refuses a config it cannot edit safely, and says why', async () => {
  // Both of these are ways a hand-edited config.toml can be shaped, and in both a
  // blind write would produce invalid TOML and take every other setting with it.
  const { setTomlKey } = await import('../lib/wtdc/toml.mjs');
  const dup = setTomlKey('[terminal]\nx = 1\n[terminal]\ny = 2\n', 'terminal', 'default_shell', SHELL);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /declared 2 times/);

  const inline = setTomlKey('terminal = { default_shell = "/bin/sh" }\n', 'terminal', 'default_shell', SHELL);
  assert.equal(inline.ok, false);
  assert.match(inline.reason, /inline table/);
});
