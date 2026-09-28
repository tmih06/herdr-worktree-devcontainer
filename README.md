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

It prints one line to add to `~/.config/herdr/config.toml`:

```toml
[terminal]
default_shell = "/path/to/this/repo/lib/wtdc/shell.mjs"
```

Then `herdr server reload-config`. The plugin never edits your config itself.

## Use it

Create a worktree the way you normally do (`prefix+shift+g`, or
`herdr worktree create`). If the checkout has a devcontainer config, an overlay
asks whether to build it. Answer yes and a tab streams `devcontainer up`; the
plugin notifies you with a sound when it finishes, and a different one if it
fails.

Afterwards, **every** terminal, split, tab, and agent you open in that worktree
runs inside its container. Split panes, layouts, and agent lifecycle all behave
normally, because they are ordinary Herdr features — only the shell they spawn
is different.

Set `WTDC_ON_CREATE=auto` to skip the question, or `never` to do nothing.

### Actions

| Action | What it does |
|---|---|
| `provision` | build a container for the current worktree |
| `status` | list tracked worktrees and whether their containers run |
| `teardown` | destroy the current worktree's container |
| `install-shell` | print the `default_shell` line to add |

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
| `WTDC_CONTAINER_ICON` | `🐳` | marker prepended to the worktree's sidebar label |
| `WTDC_EXTRA_MOUNTS` | | extra `devcontainer up --mount` value |
| `WTDC_CONFIG_CANDIDATES` | `.devcontainer/devcontainer.json .devcontainer.json` | where to look, relative to the worktree |
| `WTDC_TEMPLATE` / `WTDC_IMAGE` | | run a prebuilt image instead of building one |

Your image, features, `remoteUser`, mounts, and lifecycle commands stay
authoritative; the plugin injects nothing but a readiness marker. Object-form
`postCreateCommand` is rejected rather than silently reshaped, because it cannot
be appended to without changing its meaning.

### Prebuilt images

A config that declares any `features` makes the CLI derive a per-workspace
image, so every new worktree pays a build. The templates in `images/` bake in
what the plugin used to inject, so `up` is just `docker run`:

| Setup | Time |
|---|---|
| Building a per-worktree image | ~25s warm, minutes cold |
| Prebuilt image | ~4s |

`WTDC_TEMPLATE=node` uses one. This costs you the features in your own config;
the plugin warns and names them rather than dropping them silently.

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
lib/wtdc/{state,config,herdr,ui,run,jsonc,context}.mjs
panes/{prompt,build,container}.mjs
```

The plugin is plain ESM JavaScript with no build step, so `herdr plugin link`
works on a checkout with nothing to compile.

## Tests

```sh
node --test tests/*.test.mjs   # unit + stubbed e2e + dispatcher
bash tests/prompt-keys.sh      # the overlay, driven through a real PTY
bash tests/real-e2e.sh         # needs docker, devcontainer, and a live Herdr
```

`tests/real-e2e.sh` is the one that proves the design: it provisions a real
container and then drives the dispatcher through an actual PTY to confirm a new
terminal lands inside it. It skips with a reason when its tools are missing.
