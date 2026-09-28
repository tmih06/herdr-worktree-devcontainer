# Handoff: the boot screen destroys the worktree's workspace

State as of commit `49ff74a` on `main`. The work in that commit is **not
shippable**: the setup screen deletes the workspace it was opened in. This
document is the diagnosis and the recommended fix, so the next agent does not
have to rediscover it.

Everything in `49ff74a` that is not the boot screen works and is verified —
see "What is already working" below.

## The symptom

Create a worktree, accept the prompt. The container builds successfully, and
then the whole workspace disappears: no panes, no workspace, while the git
worktree is still on disk.

```
$ herdr worktree list          # before
  w0  final1
$ # accept prompt, wait for build
$ herdr pane list
  w7:p1  w7:pC                 # w0 is gone entirely
$ herdr workspace list
  w7  herdr-worktree-devcontainer
$ git worktree list
  .../final1  ed52eb8 [final1] # the worktree survives
```

This is why it was reported as "the init one still not in dc". The initial
terminal is not merely outside the container — it is gone, along with its
workspace. The container is real and running; there is simply no workspace
left to put a terminal in.

## Root cause

`boot.mjs` is opened with `placement: 'zoomed'` and `--target-pane <the
worktree's own shell pane>` (added in `49ff74a`; see `bootLaunch` in
`bin/wtdc.mjs` and `openPluginPane` in `lib/wtdc/herdr.mjs`).

A `zoomed` plugin pane opened against an existing pane **takes that pane's
place** rather than stacking over it. So the boot screen is running *in* the
worktree's only pane. When `boot.mjs` exits, that pane goes with it, and a
workspace with no panes is removed.

The exit is unconditional on the success path:

```js
// panes/boot.mjs, finish()
setTimeout(() => {
  process.stdout.write('\x1b[?25h');
  process.exit(0);
}, 400);
```

Confirmed: the plugin never calls `pane close` anywhere
(`grep -rn "pane close" lib/ panes/ bin/` is empty), yet the workspace still
disappears. So Herdr is removing the pane as a consequence of the process
exiting, not because the plugin asked.

This is the trap in the placement rules, and it is why the earlier `--target-pane`
version also failed. A pane opened that way is placed *relative to* its target,
and for `zoomed` that means it can consume it. The previous revision guessed the
target pane by taking the focused pane in the workspace — which was the prompt
overlay, so the boot screen was stacked on the question and died with it. That
produced the earlier "I pressed yes and nothing happened". Both failures are
the same mistake: assuming a pane can be safely stacked on another pane.

## The fix, in order of preference

### Option A — do not take over the worktree's pane (recommended)

Stop opening the boot screen with `--target-pane`. Give it its own tab and let
the worktree's shell pane be alone. This is the behaviour the user originally
asked to avoid ("currently it open another terminal for that and user can still
run around"), so it needs the blocking behaviour to come from somewhere else:
`zoomed` without a target zooms the *active* pane, which is transient and wrong.

So Option A is only correct in combination with one of:

- **A1 — close the worktree's shell pane deliberately, and let the boot screen
  replace it.** i.e. accept that the initial pane is consumed, but do it
  explicitly and leave a container-backed pane behind in its place. The current
  code already opens a `container` pane on success; the missing piece is that
  the boot screen must not vanish before that pane exists. Verify the ordering:
  provision opens the container tab (`WTDC_OPEN_CONTAINER_PANE`), and only then
  does the boot screen exit.
- **A2 — keep the pane, put the progress *inside* it.** Have the boot screen
  write to the worktree's pane as an overlay-style full-screen render without
  being a separate pane process at all. This inverts the current design: no
  `boot.mjs` pane, just the provisioner rendering progress into the existing
  terminal. Most invasive, but it is the only version where the initial terminal
  survives.

### Option B — capture the pane, restore it after

If a separate pane is genuinely wanted: record the target pane id, and when the
boot screen exits, re-create the worktree's shell in a fresh pane. Verify that
Herdr does not simply reap the workspace in the gap between exit and re-create;
that race is the whole problem, so a sleep is not a fix.

Whichever option is taken, add a test that asserts the worktree's workspace
still exists after a successful provision. There is no such test today, which is
why 45 passing assertions coexisted with a workspace-destroying bug.

## Reproducing

Needs Docker access and a running Herdr. If your shell lacks the `docker`
group, pane-spawned processes still have it, so test through Herdr rather than
by running `bin/wtdc.mjs` directly — a direct run fails on `docker ps` and
proves nothing about the pane lifecycle.

```sh
herdr server reload-config          # required after any herdr-plugin.toml edit
herdr worktree create --branch handoff-repro
# accept the prompt; wait for the build to finish
herdr workspace list                # the new workspace is gone
git worktree list                   # the worktree is still there
herdr worktree remove --workspace <id> --force
node bin/wtdc.mjs teardown /home/tmih06/.herdr/worktrees/herdr-worktree-devcontainer/handoff-repro
```

## The placement rules, measured

These are Herdr's actual responses, not inferred. Getting them wrong fails
silently, which is the recurring theme.

| Placement | `--workspace` | `--cwd` | `--target-pane` |
|---|---|---|---|
| `tab` | accepted | accepted | accepted |
| `overlay` / `popup` | **rejected** | **rejected** | **rejected** |
| `zoomed` / `split` | **rejected** | accepted | accepted — and consumes the target for `zoomed` |

Rejection message for overlay:
`overlay and popup plugin panes target the active pane`.
For zoomed/split: `split and zoomed plugin panes target an existing pane; use target_pane_id`.

An untargeted pane always resolves to the **active** pane, so a placement that
cannot be targeted must have its workspace focused first
(`herdr.focusWorkspace`) or it lands wherever the user happened to be.

## What is already working — do not regress it

- **Prebuilt base image by default.** `WTDC_TEMPLATE=base` in both
  `lib/wtdc/config.mjs` DEFAULTS and `config/config.default.env`, verified
  resolving to `ghcr.io/tmih06/herdr-devcontainer-base:latest` against real
  Docker. A fresh install no longer derives a per-workspace image from the
  config's `features`, and the plugin still warns by name when features are
  dropped.
- **The shell dispatcher.** A plain split pane in a provisioned worktree lands
  in the container: `dev@<id>:/workspaces/<name>$`. This is the core of the
  design and it works.
- **The progress protocol** (`lib/wtdc/progress.mjs`) and the progress bar. The
  long `devcontainer up` phase is drawn indeterminate because that command
  reports nothing until it returns; do not replace that with a guessed
  percentage.
- **Five silent-failure fixes**, all the same class of bug — a command that
  failed while looking like it succeeded:
  1. `openPluginPane` sent `--workspace`/`--cwd` to an overlay; Herdr rejects
     both, so the prompt never opened and the hook still exited 0.
  2. `herdr()` discarded failed output, so a rejected pane open looked
     identical to a successful one.
  3. `run()` preferred `stderr || stdout`, but the devcontainer CLI writes its
     version banner to stderr and the real error to stdout.
  4. The boot screen showed 100% with every phase ticked when the build failed.
  5. Overlay stdout went nowhere, hiding "disabled inside a dev container".

Tests: 45 assertions (`node --test tests/*.test.mjs`) and 11 PTY key checks
(`bash tests/prompt-keys.sh`) pass.

## Two things that will waste your time otherwise

**`herdr server reload-config` after editing `herdr-plugin.toml`.** Until then
Herdr still accepts `plugin pane open` for a new entrypoint, returns a pane id,
and runs nothing — the pane appears and vanishes with no output. This looks
like the plugin refusing to start, not a stale command table. It is documented
in the README now.

**Unlinking and re-linking the plugin also requires a reload**, and does not
reliably fix a stale table on its own.

## Housekeeping

The user's live config was changed during this work and is not in git:

- `~/.config/herdr/config.toml` gained a `[terminal]` block pointing
  `default_shell` at `lib/wtdc/shell.mjs`. Backup at
  `~/.config/herdr/config.toml.bak-before-wtdc`. Reverting restores the original
  config and disables the dispatcher.
- `~/.config/herdr/plugins/config/worktree-devcontainer/config.env` has
  `WTDC_TEMPLATE=base` set by hand.
- A stale second config copy at
  `~/.config/herdr/plugins/worktree-devcontainer/config.env` (note: no
  `config/` segment) was deleted. The plugin reads that path when
  `HERDR_PLUGIN_CONFIG_DIR` is unset, and a stale copy there silently overrides
  the real config — it is worth guarding against in code, since the fallback
  path in `lib/wtdc/context.mjs` does not match what `herdr plugin config-dir`
  reports.
- Stray test worktrees and containers may remain under
  `~/.herdr/worktrees/herdr-worktree-devcontainer/`. `git worktree list` and
  `$HERDR_PLUGIN_STATE_DIR/state.json` list them; `node bin/wtdc.mjs teardown
  <path>` destroys the container.
