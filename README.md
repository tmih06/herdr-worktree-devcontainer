# Worktree Dev Container

`worktree-devcontainer` runs each Herdr Git worktree's own
`.devcontainer/devcontainer.json` and makes every terminal in that worktree
open inside the resulting container.

The worktree stays what Herdr already made it: a normal worktree, grouped under
its repository, with its branch and Git provenance intact. There is no extra
machine in the sidebar and no second Herdr session. What changes is where the
shells run.

## Requirements

| Tool | Why |
|---|---|
| Herdr 0.9.0+ | the plugin API |
| Docker | runs the container |
| `devcontainer` | the Dev Container CLI (`npm i -g @devcontainers/cli`) |
| `node` | runs the plugin |
| `git` | worktree metadata |

`node` is not optional: the Dev Container CLI is an npm package, so it is
already on any machine where `devcontainer` runs.

## Install

```sh
herdr plugin link /path/to/this/repo     # or: herdr plugin install owner/repo
herdr plugin enable worktree-devcontainer
```

Then **install the shell dispatcher** — this is the step that makes terminals
land in the container:

```sh
herdr plugin action invoke worktree-devcontainer.install-shell
```

It points `terminal.default_shell` at the dispatcher in `~/.config/herdr/config.toml`,
keeps a `.bak-before-wtdc` copy of what was there, and reloads the server so it takes
effect immediately:

```toml
[terminal]
default_shell = "/path/to/this/repo/lib/wtdc/shell.mjs"
```

That one line is the whole integration. Herdr spawns it for every new pane, tab and
terminal, and it decides per pane: a pane whose working directory is a provisioned
worktree is `docker exec` into that worktree's container, and a pane anywhere else is
your real `$SHELL`, unchanged. Without it nothing warns you — a terminal opened after a
container is ready looks exactly like one opened before, because both are the host
shell. The action is safe to re-run, and refuses to touch a `config.toml` it cannot edit
without guessing.

## Use it

Create a worktree the way you normally do (`prefix+shift+g`, or
`herdr worktree create`). If the checkout has a devcontainer config, an overlay
asks whether to build it. Answer yes and a setup screen opens zoomed over that
worktree's pane, with a progress bar through each stage. It holds the keyboard
until the container is ready, and `Esc` cancels. The plugin notifies you with a
sound when it finishes, and a different one if it fails.

**When the build succeeds, that pane becomes the container terminal.** The
worktree's first pane was spawned before the container existed, so it is a host
shell; the setup screen hands its own pane to `docker exec` and retires the host
one, so the worktree is left with a single terminal that is already inside the
container. The plugin opens no second tab, and there is no window in which the
workspace has no panes — which matters, because Herdr removes a workspace the
moment its last pane closes, taking the worktree out of the sidebar while the
checkout is still on disk.

If the build fails, the screen stays up with the tool's own error, `Esc` or any key
dismisses it, and the host shell is deliberately left alone so there is somewhere to
retry from.

Afterwards, **every** terminal, split, tab, and agent you open in that worktree
runs inside its container — that is what the dispatcher is for. Split panes,
layouts, and agent lifecycle all behave normally, because they are ordinary Herdr
features; only the shell they spawn is different.

Set `WTDC_ON_CREATE=auto` to skip the question, or `never` to do nothing.

### Actions

| Action | What it does |
|---|---|
| `provision` | build a container for the current worktree |
| `status` | list tracked worktrees and whether their containers run |
| `teardown` | destroy the current worktree's container |
| `install-shell` | point `terminal.default_shell` at the dispatcher, back up the config, reload |

## How it works

Herdr spawns `terminal.default_shell` for each new pane. The plugin points
that at a dispatcher which asks one question: *is this pane's working directory
inside a worktree that has a container?* If yes, `docker exec` into it. If no,
`exec` your real `$SHELL` — so the dispatcher is inert everywhere else.

```
myrepo (main)
  feat-payments          ← a normal Herdr worktree
     pane 1  →  docker exec … bash
     pane 2  →  docker exec … bash
```

Two things make this work rather than merely look like it works:

**Agent detection still functions.** Herdr classifies agents from the pane's
screen buffer, not the process tree, so an agent running inside `docker exec` is
detected, named, and tracked normally. (One caveat: `herdr agent start` checks
that the pane's *interactive shell* owns the foreground, and on the host that
process is `docker`. Launching agents by typing them works; programmatic start
may not.)

**Git works inside the container.** A linked worktree stores its git metadata
as a `.git` **file** pointing at `<main-repo>/.git/worktrees/<name>`, which lies
outside the worktree. The Dev Container CLI mounts only the workspace folder, so
that pointer dangles in the container and every `git` command fails. The plugin
bind-mounts the main repository's `.git` at the identical host path. Verified:

```
worktree only     -> ls /main/.git/worktrees/<name>: No such file or directory
worktree + .git   -> HEAD ORIG_HEAD commondir gitdir index logs
```

A main checkout is its own common directory, is already mounted as the
workspace, and gets no extra mount.

### Why not a saved SSH machine?

An earlier version made each container a saved SSH machine, so it got a full
Herdr session of its own. That works, but a machine is a separate Herdr server,
so its workspaces render beneath a **machine node** in the sidebar — the
worktree disappears from under its repository, which is the main thing you want
a worktree for. It also required injecting an sshd feature, publishing a port,
generating a keypair, and installing a Herdr server inside every container.

The shell dispatcher gets the same isolation — a real filesystem, real
processes, real package and port separation — with none of that, and without
the worktree moving.

## Configuration

Herdr copies [`config/config.default.env`](config/config.default.env) to its
plugin config directory on first use; edit that copy. Environment variables
given when invoking `bin/wtdc.mjs` take precedence.

| Key | Default | Meaning |
|---|---|---|
| `WTDC_ENABLED` | `1` | master switch for hooks and actions |
| `WTDC_ON_CREATE` | `prompt` | `prompt`, `auto`, or `never` |
| `WTDC_NOTIFY` | `1` | notify when the build finishes or fails |
| `WTDC_BUILD_TIMEOUT` | `1800` | seconds to wait for the readiness marker |
| `WTDC_KEEP_CONTAINER` | `0` | keep the container when the worktree is removed |
| `WTDC_OPEN_CONTAINER_PANE` | `1` | open a container tab when the build finishes |
| `WTDC_HOSTNAME` | `branch` | container hostname: `branch`, `off`, or a literal |
| `WTDC_CONTAINER_ICON` | `🐳` | marker prepended to the worktree's sidebar label |
| `WTDC_EXTRA_MOUNTS` | | extra `devcontainer up --mount` value |
| `WTDC_CONFIG_CANDIDATES` | `.devcontainer/devcontainer.json .devcontainer.json` | where to look, relative to the worktree |
| `WTDC_TEMPLATE` / `WTDC_IMAGE` | `base` | run a prebuilt image instead of building one |

Your image, features, `remoteUser`, mounts, and lifecycle commands stay
authoritative; the plugin injects nothing but a readiness marker and a
`--hostname`. Object-form `postCreateCommand` is rejected rather than silently
reshaped, because it cannot be appended to without changing its meaning.

### The prompt says which worktree you are in

```
dev@feature-login-form:/workspaces/feature-login-form$
```

That part after the `@` is the container's hostname, which Docker otherwise sets
to the container id — `dev@f4f6e36af45d:` tells you nothing. The plugin passes
`--hostname` to the container it starts, using the branch the worktree is
checked out on, folded into a legal hostname (`feat/payments` becomes
`feat-payments`, uppercase and underscores become hyphens, and it is capped at 63
characters).

Two things worth knowing: a hostname is fixed when a container is created, so
changing `WTDC_HOSTNAME` applies to the *next* provision rather than to a
container that is already running; and a `--hostname` in your own
`devcontainer.json` `runArgs` always wins, because your config is authoritative
about your container. Set `WTDC_HOSTNAME=off` to keep the container id, or a
literal string to pin it.

### Prebuilt images

A config that declares any `features` makes the CLI derive a per-workspace
image, so every new worktree pays a build. The templates in `images/` bake in
what the plugin used to inject, so `up` is just `docker run`:

| Setup | Time |
|---|---|
| Building a per-worktree image | ~25s warm, minutes cold |
| Prebuilt image | ~4s |

`WTDC_TEMPLATE` defaults to `base`, so a new install is already on the fast
path. Use `node`, `python`, or `rust` for a toolchain. This costs you the
features in your own config; the plugin warns and names them rather than
dropping them silently. Blank `WTDC_TEMPLATE` to go back to letting the CLI
build from your config's features.

## State and cleanup

State lives at `$HERDR_PLUGIN_STATE_DIR/state.json`, keyed by absolute checkout
path, and holds the container id, name, user, and container-side workspace path
the dispatcher needs on every new pane. The merged config is removed with the
entry. A failed build drops its partial entry so the worktree stays retryable,
and the `worktree.removed` hook also sweeps containers by Docker's
`devcontainer.local_folder` label, so a build that died before state was written
is still cleaned up.

## Layout

```
bin/wtdc.mjs          CLI: hooks, actions, provision, teardown, status
lib/wtdc/shell.mjs    the dispatcher installed as terminal.default_shell
lib/wtdc/devcontainer.mjs  config discovery, merge, container lifecycle
lib/wtdc/containerShell.mjs the container terminal, shared by both routes into one
lib/wtdc/toml.mjs     the one edit made to config.toml
lib/wtdc/{state,config,herdr,ui,run,jsonc,context,progress}.mjs
panes/{prompt,boot,build,container}.mjs
```

The plugin is plain ESM JavaScript with no build step, so `herdr plugin link`
works on a checkout with nothing to compile.

**Pane commands are spelled through `$HERDR_PLUGIN_ROOT`, not left relative.**
A plugin pane runs with the working directory it was opened with — the worktree's
checkout — so `["node", "panes/boot.mjs"]` resolves inside the *user's* repository.
It appears to work while you develop this plugin in a worktree of itself, and does
nothing at all everywhere else. Herdr does not expand the variable, hence the
`sh -c "exec node …"` in `herdr-plugin.toml`.

Editing `herdr-plugin.toml` — adding a pane, changing a command — needs
`herdr server reload-config` before it takes effect. Until then Herdr still
accepts `plugin pane open` for the new entrypoint, returns a pane id, and then
runs nothing, because it has the old command table. The pane appears and
vanishes with no output, which looks like the plugin refusing to start rather
than a stale manifest.

## Tests

```sh
node --test tests/*.test.mjs   # unit + stubbed e2e + dispatcher
bash tests/prompt-keys.sh      # the overlay, driven through a real PTY
bash tests/real-e2e.sh         # needs docker, devcontainer, and a live Herdr
```

`tests/real-e2e.sh` is the one that proves the design: it provisions a real
container, drives the dispatcher through an actual PTY to confirm a new terminal
lands inside it, and then opens a real setup screen over a real workspace to
confirm the worktree's workspace is still there afterwards and that its terminal
is the container. It skips with a reason when its tools are missing.

`WTDC_IMAGE` overrides the image the real test provisions, which is how to run it
on a host whose architecture the published templates do not cover:

```sh
WTDC_IMAGE=my-local-arm64-image bash tests/real-e2e.sh
```
