# Worktree Dev Container

`worktree-devcontainer` runs each Herdr Git worktree's own
`.devcontainer/devcontainer.json` and makes every terminal in that worktree
open inside the resulting container.

The worktree stays what Herdr already made it: a normal worktree, grouped under
its repository, with its branch and Git provenance intact. There is no extra
machine in the sidebar and no second Herdr session. What changes is where the
shells run.

## Requirements

| Tool           | Why                                                   |
| -------------- | ----------------------------------------------------- |
| Herdr 0.9.0+   | the plugin API                                        |
| Docker         | runs the container                                    |
| `devcontainer` | the Dev Container CLI (`npm i -g @devcontainers/cli`) |
| `node`         | runs the plugin                                       |
| `git`          | worktree metadata                                     |

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
asks whether to build it — and tells you what answering yes would cost, because
that is not knowable from the config file alone:

```
  Dev container

  Worktree  feature-login-form
            /home/you/.herdr/worktrees/myrepo/feature-login-form
  Config    .devcontainer/devcontainer.json
            repo myrepo
  Image     ghcr.io/tmih06/herdr-devcontainer-node:latest
            not on this machine — will be pulled  138 MB
  Features  none
  Mounts    /usr/bin/btop → /usr/local/bin/btop  read-only
  Setup     no image build from features — a docker run
            and a uid-matched copy of the image (~300 MB, tens of seconds)
            user dev
            hostname feature-login-form
```

The image line is the part worth having: whether it is already on this machine,
whether the registry has published a newer one, and how big a pull would be. It
is resolved _after_ the first frame and fills in when it arrives, so a slow
registry never holds the question hostage — and when it cannot be answered the
line says so rather than implying the image is current.

Registry comparison prefers Docker Buildx and falls back to Docker's built-in
`manifest inspect --verbose` when the Buildx lookup fails. The fallback compares
the published configuration for this host's architecture to the local image ID,
so it does not mistake another architecture's digest for a local image update.
If both registry checks fail, the line still says `already pulled` and explains
why comparison is unavailable. A failed local Docker
inspection reports `local image check failed` with the error; only Docker's
`No such image` response means the image needs pulling.

`Features` names what a template would drop. For local features, `Cache` checks
the same build inputs that provisioning uses and reports a matching feature
image and, separately, a cached UID/GID-adjusted image. With both cached, `Setup`
says `reuses cached image — creates a container`. Without a match it describes
the build; when reuse cannot be checked or supported it explains why. Config,
local feature file and image-field edits refresh that result. These inspections
run after the first frame, write no build snapshot and start no container, so a
busy Docker daemon cannot block the question. Closing it cancels pending checks.

The Dev Container CLI can build a `vsc-…-uid` copy when the container user's uid
differs from the host's. `Setup` includes that cost unless UID updates are
disabled or a matching adjusted image is cached. Where the image does not say
which uid its user has, the line describes that cost as conditional.

`Mounts` names what the container will have of the host's, in the `mounts` array
of your own config — the devcontainer-native way to borrow a host binary instead
of installing it in every worktree, and the plugin has nothing to do with it. A
bind that is **not** read-only is called out, because it means anything running
in the container can change a file of yours: the container user has your uid, so
nothing else stops it. Note that the devcontainer CLI drops `readonly` from the
object form of a mount, so write the string form.

**The image is editable, and the question is still answerable with one key.** The
field starts holding whatever `devcontainer.json` says, and `↑`/`↓` move between
it and the answer. Focus starts on the answer, so `y`, `Enter` and `space` work
the instant the dialog opens; only once you are on the image does a letter type
into it, which is the only way an image reference containing `n` or `y` can be
typed at all.

|                              |                                                         |
| ---------------------------- | ------------------------------------------------------- |
| `↑` `↓`                      | move between the image and the answer                   |
| `y` `Enter`                  | yes — from the answer; leaves the field, from the image |
| `n` `Esc` `q`                | no — or, in the field, put the config's image back      |
| `space`                      | toggle the checkbox                                     |
| `←` `→` `Backspace` `Ctrl-U` | caret, delete, clear the image field                    |

The check waits for you to stop typing — one second of quiet — so a check per
keystroke cannot turn a word into a queue of registry lookups, and a lookup that
comes back for an image you have already replaced is thrown away rather than
shown. What you type is what gets built: the override travels with the build and
replaces the image _only_, so unlike a template it leaves the config's `features`
in place. Leave the field alone and the config's own image is used.

Answer yes and a setup screen opens zoomed over that worktree's pane, with a
progress bar through each stage. It holds the keyboard until the container is
ready, and `Esc` cancels. The plugin notifies you with a sound when it finishes,
and a different one if it fails.
When the image is missing locally, the screen shows Docker's layer download and
extraction updates during the pull. The setup bar advances through its pull
portion as those layers progress and never empties between updates.

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

The worktree's own row in the sidebar gets a 🐳 in front of its name while the
container is there, so a glance is enough to tell which worktrees are in one.
The plugin updates the workspace label Herdr shows by default, then restores
the original label on `teardown`. If you rename the workspace yourself while
the container is running, that new name is preserved. Set
`WTDC_CONTAINER_ICON` to change the marker, or to `''` to switch it off.

Set `WTDC_ON_CREATE=auto` to skip the question, or `never` to do nothing.

### Actions

| Action                   | What it does                                                                   |
| ------------------------ | ------------------------------------------------------------------------------ |
| `reopen-container`       | choose config, then start/reuse the project's or worktree's container          |
| `rebuild-container`      | rebuild from the selected config and reopen, preserving named volumes          |
| `reopen-host`            | open a host terminal and stop the container, keeping its data for later        |
| `provision`              | build a container for the current worktree                                     |
| `status`                 | list tracked worktrees and whether their containers run                        |
| `teardown`               | destroy the container and its owned DinD storage                               |
| `remove-worktree`        | remove the containers and DinD volumes before deleting the Git worktree        |
| `cleanup`                | retry pending cleanup and reclaim tracked resources whose Git metadata is gone |
| `install-native-cleanup` | enable Docker-first ordering in Herdr's native worktree removal                |
| `install-shell`          | point `terminal.default_shell` at the dispatcher, back up the config, reload   |

Herdr 0.9.1 does not display plugin actions in the workspace right-click menu.
Focus the project or worktree you want to reopen and invoke the action:

```sh
herdr plugin action invoke worktree-devcontainer.reopen-container
```

For TUI shortcuts, add these entries to `~/.config/herdr/config.toml` and run
`herdr config check`, then `herdr server reload-config`. With the default prefix,
press **Ctrl+B**, release it, then **d** to reopen, **f** to rebuild, or **u** to
return to the host. Each action targets the focused workspace. Choose different
keys if these conflict with your existing bindings.

```toml
[[keys.command]]
key = "prefix+d"
type = "plugin_action"
command = "worktree-devcontainer.reopen-container"
description = "Reopen in dev container"

[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "worktree-devcontainer.rebuild-container"
description = "Rebuild and reopen in dev container"

[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "worktree-devcontainer.reopen-host"
description = "Reopen on host (keep container data)"
```

In a linked worktree, press **c** in the dialog to switch
between **Main checkout** and **This worktree**. The preview, cache check and
resulting build use that selection. Accepting remembers it for that checkout;
canceling leaves the saved choice alone. A missing selected config is shown as
missing, so you can create or edit it while the dialog is open.

Press **r** to choose a rebuild, or use **Dev container: rebuild and reopen…**
after editing the config. Switching config source also requires a rebuild.
Reopening with the same source starts the saved container without an image build;
if it was removed, the plugin creates another. Existing project panes are kept.
Reopening uses a new tab, preserving their layout. When setup finishes, its label
and zoom are cleared before the terminal enters the container.

**Dev container: reopen on host (keep data)** remembers host mode, opens a host
terminal, and stops that checkout's container. New panes use the host even after
Herdr restarts. The stopped container and both DinD storage volumes remain so
you can reopen later without losing nested Docker/Postgres data. A rebuild also
keeps named volumes; programs running in the container stop when it is replaced.
Use **destroy container and DinD data** or **remove worktree, container and
volumes** when you intend to delete that storage.

## How it works

Herdr spawns `terminal.default_shell` for each new pane. The plugin points
that at a dispatcher which asks one question: _is this pane's working directory
inside a worktree that has a container?_ If yes, `docker exec` into it. If no,
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
that the pane's _interactive shell_ owns the foreground, and on the host that
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

## Your `devcontainer.json`

The plugin does not invent a container. It finds this file — `.devcontainer/devcontainer.json`
or `.devcontainer.json`, in that order, overridable with `WTDC_CONFIG_CANDIDATES` — and
provisions from it. Yours is authoritative: image, features, `remoteUser`, mounts and
lifecycle commands are all used as written.

By default it reads that file from the **main checkout**, not from the worktree, and reads
it off disk rather than out of a commit. A worktree records the commit it was created at,
not the branch it came from, so "the config as of the branch it branched from" is not a
question git can answer — and a worktree nobody has merged yet holds a config that is
already behind. Reading the main checkout means an edit there applies to every worktree at
once, uncommitted, which is where edits actually happen. Choose **This worktree** in
the reopen dialog when a branch changes its own `devcontainer.json`; the selection
is saved per checkout. `WTDC_CONFIG_SOURCE=worktree` sets the global default for
checkouts without a saved choice. The dialog shows which checkout supplies the file.

When the main config references `${localWorkspaceFolder}/.devcontainer`, the plugin
copies the main checkout's `.devcontainer` files into a private directory beside
that worktree's merged config and rewrites those explicit host paths to the copy.
This lets `initializeCommand` use scripts such as `host-tools.sh` even when an
older worktree has no such script. Files created there and the mounts that consume
them share the same per-worktree directory, which is removed during teardown.
Other workspace paths still refer to the actual worktree. Relative commands such
as `sh .devcontainer/script.sh` retain their normal worktree-relative behavior.
With `WTDC_CONFIG_SOURCE=worktree`, initialization uses the worktree's own files.

Local features such as `./features/cli-tools` are copied from the selected config's
`.devcontainer` directory into a per-worktree snapshot. The CLI builds their image
there, then starts it against the actual worktree. Initialization commands, workspace
mounts, and lifecycle commands still use the actual checkout. This also supports
main-checkout features that are absent from an older worktree.

For an image base with only local features, identical build inputs share one
feature image across worktrees. The key includes the base image ID, feature files
and options, user settings, and CLI version. After the first successful startup,
the CLI's UID/GID-adjusted image is also reused for the same host IDs and user.
Container creation and lifecycle commands still run for each worktree. Changed
inputs or removed cached images trigger a build. Dockerfile builds, remote feature
dependencies, and configurations with variable substitutions continue to use the
CLI's normal build cache.

If setup fails, the screen shows the error before the stack trace and the path to
a complete private log under the plugin state directory's `logs` folder. The log
remains available after the setup pane closes.

The simplest version that works, and the one this repository uses for itself:

```jsonc
{
  "name": "myproject",
  "image": "ghcr.io/tmih06/herdr-devcontainer-node:latest",
  "remoteUser": "dev",
  "postCreateCommand": "npm ci",
}
```

Naming one of the [prebuilt images](images/README.md) is the fast path: with no
`features` in the config, a provision is a `docker run` rather than an image build,
so a new worktree costs seconds instead of a build. See
[`images/README.md`](images/README.md) for what each one contains.

Declaring `features` is the alternative, and it is the one to know the cost of:

```jsonc
{
  "name": "myproject",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": {},
  },
  "postCreateCommand": "npm ci",
}
```

That works and nothing is overridden — but any `features` entry makes the Dev Container
CLI derive a **per-workspace image**, so every new worktree of this repo pays a build
(~25s warm, minutes cold) before it can start. Two ways out: drop the features and name
a prebuilt image that already has the toolchain, or set `WTDC_TEMPLATE` to replace the
image — which does drop your `features`, so the plugin names each one it drops rather
than dropping it quietly.

The plugin sets `waitFor` to `postCreateCommand` in its temporary config copy, so the
Dev Container CLI waits for your lifecycle command to finish before provisioning
returns. Your `postCreateCommand` keeps its original string, array, or object shape.
The build timeout applies to this wait as well as the CLI work. The plugin also adds
`--hostname <branch>` in `runArgs`, so the prompt says which worktree you are in. A
`--hostname` you set yourself always wins. See `WTDC_HOSTNAME`.

### Mount host tools and authentication files

This example follows this repo's [.devcontainer/devcontainer.json](.devcontainer/devcontainer.json).
It mounts LazyGit, the complete Codex installation, and the host's Codex login
into the container as read-only bind mounts:

```jsonc
{
  "name": "my-project",
  "image": "ghcr.io/tmih06/herdr-devcontainer-node:latest",
  "remoteUser": "dev",
  "mounts": [
    "type=bind,source=${localEnv:HOME}/.local/bin/lazygitrs,target=/usr/local/bin/lazygit,readonly",
    "type=bind,source=${localEnv:HOME}/.codex/packages/standalone/current,target=/opt/codex,readonly",
    "type=bind,source=${localEnv:HOME}/.codex/auth.json,target=/home/dev/.codex/auth.json,readonly",
  ],
  "postCreateCommand": "sudo chown dev:dev /home/dev/.codex && sudo chmod 700 /home/dev/.codex && sudo ln -sf /opt/codex/bin/codex /usr/local/bin/codex",
}
```

`${localEnv:HOME}` resolves to the host's home directory. Use it instead of a
literal `~`, which Docker does not expand. Adjust the source paths to your host's
installation and remove mounts for tools you do not use; each source must exist
before starting the container.

Codex needs its companion binaries and resources, so the example mounts the
whole installation directory. The setup command links its executable into
`PATH` and makes `/home/dev/.codex` writable for local state while the mounted
authentication file stays read-only. If your image uses another `remoteUser`,
adjust the home path and ownership command. After changing mounts, rebuild with
**Ctrl+B**, then **f**, if you installed the shortcuts above.

## Configuration

Herdr copies [`config/config.default.env`](config/config.default.env) to its
plugin config directory on first use; edit that copy. Environment variables
given when invoking `bin/wtdc.mjs` take precedence.

| Key                            | Default                                              | Meaning                                                                                           |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `WTDC_ENABLED`                 | `1`                                                  | master switch for hooks and actions                                                               |
| `WTDC_ON_CREATE`               | `prompt`                                             | `prompt`, `auto`, or `never`                                                                      |
| `WTDC_NOTIFY`                  | `1`                                                  | notify when the build finishes or fails                                                           |
| `WTDC_BUILD_TIMEOUT`           | `1800`                                               | maximum seconds for `devcontainer up`, including `postCreateCommand`                              |
| `WTDC_KEEP_CONTAINER`          | `0`                                                  | keep the container when the worktree is removed                                                   |
| `WTDC_OPEN_CONTAINER_PANE`     | `1`                                                  | hand the setup pane over to a container shell when the build finishes; `0` leaves the host shell  |
| `WTDC_HOSTNAME`                | `branch`                                             | container hostname: `branch`, `off`, or a literal                                                 |
| `WTDC_CONTAINER_ICON`          | `🐳`                                                 | marker prepended to the worktree's sidebar label while its container exists                       |
| `WTDC_EXTRA_MOUNTS`            |                                                      | extra `devcontainer up --mount` value                                                             |
| `WTDC_CONFIG_CANDIDATES`       | `.devcontainer/devcontainer.json .devcontainer.json` | where to look, relative to the source directory                                                   |
| `WTDC_CONFIG_SOURCE`           | `main`                                               | read the config from the main checkout's file on disk, or `worktree` for each worktree's own copy |
| `WTDC_TEMPLATE` / `WTDC_IMAGE` | _(blank)_                                            | run a prebuilt image instead of the one your config declares                                      |

Your image, features, `remoteUser`, mounts, and lifecycle commands stay
authoritative. The plugin sets `waitFor` to `postCreateCommand` and adds a
`--hostname`; it does not rewrite the lifecycle command.

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
changing `WTDC_HOSTNAME` applies to the _next_ provision rather than to a
container that is already running; and a `--hostname` in your own
`devcontainer.json` `runArgs` always wins, because your config is authoritative
about your container. Set `WTDC_HOSTNAME=off` to keep the container id, or a
literal string to pin it.

### Prebuilt images

A config that declares any `features` makes the CLI derive a per-workspace
image, so every new worktree pays a build. The templates in `images/` exist to
skip that, but **nothing applies one unless you ask**:

```sh
WTDC_TEMPLATE=node     # a template by name
WTDC_IMAGE=my/image:tag  # or your own image
```

| Setup                         | Time                    |
| ----------------------------- | ----------------------- |
| Building a per-worktree image | ~25s warm, minutes cold |
| Prebuilt image                | ~4s                     |

`WTDC_TEMPLATE` is blank by default, so **your `devcontainer.json` decides what
runs**. A default that quietly replaced the declared image would make that file
misleading — and it was: the provision log named one image, the config named
another, and the only clue was a warning about dropped features. Opting in does
replace your `image` and drop your `features`, and the plugin names each feature
it drops rather than dropping it quietly.

You often do not need a template at all. A config that declares no features is
already a `docker run`, and one that names a prebuilt image itself is too — this
repository's own `.devcontainer/devcontainer.json` does exactly that, so a
worktree of this repo provisions in seconds with nothing configured.

All templates are published for **linux/amd64 and linux/arm64** as one multi-arch
tag. That is not decoration: the CLI builds a uid-remapped copy of the image with
an explicit `--platform`, so an amd64-only tag on an ARM host fails outright
rather than falling back. See [`images/README.md`](images/README.md).

That remap is also why the plugin reads the `devcontainer.remote.uid` label and
writes `updateRemoteUserUID: false` when the image already ships the host's uid.
Without it the CLI copies the whole image to change a `/etc/passwd` line that is
already correct — a `vsc-…-uid` image per worktree, hundreds of megabytes each,
rebuilt on every provision because the original is never the one that runs. The
label is read from the local image, so an image that is not here yet is pulled
first: an unreadable label is `unknown`, and `unknown` cannot be treated as
permission to skip the check.

## State and cleanup

State lives at `$HERDR_PLUGIN_STATE_DIR/state.json`, keyed by absolute checkout
path, and holds the container id, name, user, and container-side workspace path
the dispatcher needs on every new pane. The merged config is removed with the
entry, after container removal succeeds. A failed build drops its partial entry
so the worktree stays retryable, and cleanup also sweeps containers by Docker's
`devcontainer.local_folder` label, so a build that died before state was written
can still be cleaned up.

For Herdr's native right-click **Remove worktree**, first run the **Dev container:
enable cleanup for native worktree removal** action, or:

```sh
node bin/wtdc.mjs install-native-cleanup
```

This installs a Git launcher at `~/.local/bin/git`. Herdr's server must have
`~/.local/bin` before the original Git executable on its PATH; if it already does,
the launcher takes effect immediately. The installer refuses to replace an unrelated
Git executable. Ordinary commands run the original Git directly. Removal of a tracked
worktree runs Docker cleanup first and leaves Git intact if cleanup fails. Untracked
worktrees keep Git's normal behavior. `WTDC_ENABLED=0` disables interception, and
`WTDC_KEEP_CONTAINER=1` still deliberately keeps containers. Removing the installed
launcher restores the original PATH lookup.

Git can unregister a worktree and delete `.git` before failing to remove the checkout
directory. Herdr then emits no removal event. The launcher finishes this partial
deletion only after Docker cleanup, successful verification that Git no longer
registers the path, and confirmation that the original directory has not been
replaced. It makes owner-readonly directories writable without following symlinks.

You can also use the **Dev container: remove worktree, container and volumes** action to remove
a containerised worktree. It checks for uncommitted changes, removes the containers
and their two plugin-owned DinD volumes, then calls Herdr to remove the Git worktree.
If Docker cleanup fails, the checkout stays intact. From the host CLI:

```sh
node bin/wtdc.mjs remove-worktree <workspace-id>
```

Without the launcher, Herdr's built-in removal deletes Git first: its `worktree.removed` event runs
**after the checkout has been deleted**, and Herdr 0.9.1 provides no cancellable
pre-removal hook. The launcher or plugin removal action provides Docker-first ordering.

Cleanup records a pending entry and inspects the owned volume mounts before deleting
any container. Volume names stay in state until cleanup finishes, including after
the container has disappeared. User-defined volumes are preserved. Cleanup removes
the saved container and all containers labelled for the checkout. A Docker query or removal
failure reports an error and retains state and the merged config for retry; one
failed removal does not prevent attempts to remove the other containers.
On startup, the plugin retries pending cleanup and cleans tracked containers whose
checkout or `.git` metadata no longer exists. The **Dev container: retry interrupted
cleanup** action runs the same recovery immediately, without needing a Git workspace.
The destroy action also resolves saved workspace IDs when Herdr has lost Git membership.
`WTDC_KEEP_CONTAINER=1` skips automatic removal, except an explicitly forced cleanup
already in progress.
It also keeps staged config assets that the container may need as bind sources
on restart; a later forced teardown removes them.
To retry manually, including for an untracked container at a deleted path:

```sh
node bin/wtdc.mjs teardown /absolute/path/to/worktree --force
```

Named DinD volumes leaked by older versions after their containers were deleted
cannot be associated with a checkout anymore; they need a one-time removal after
checking that no container uses them. An untracked container whose removal hook
never started still needs cleanup by its checkout path.

## Layout

```
bin/wtdc.mjs          CLI: hooks, actions, provision, teardown, status
bin/git.mjs           pre-removal cleanup for tracked worktrees via the Git launcher
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
checkout — so `["node", "panes/boot.mjs"]` resolves inside the _user's_ repository.
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
npm test                        # unit + stubbed e2e + dispatcher  (node --test tests/*.test.mjs)
npm run lint                    # eslint, recommended rules only
npm run format                  # prettier --write .   (format:check is the gate)
bash tests/prompt-keys.sh       # the overlay, driven through a real PTY
bash tests/real-e2e.sh          # needs docker, devcontainer, and a live Herdr
```

The plugin itself has no dependencies and no build step — it is plain ESM run by
the node Herdr already has. Everything in `devDependencies` exists for the two
checks above, and CI runs the same scripts rather than its own invocations, so
`npm test` and the test job cannot drift apart.

`tests/real-e2e.sh` is the one that proves the design: it provisions a real
container, drives the dispatcher through an actual PTY to confirm a new terminal
lands inside it, and then opens a real setup screen over a real workspace to
confirm the worktree's workspace is still there afterwards and that its terminal
is the container. It skips with a reason when its tools are missing — which is
also why it is not in CI, where it would exit 0 having tested nothing and read as
a green check.

`WTDC_IMAGE` overrides the image the real test provisions, which is how to run it
on a host whose architecture the published templates do not cover:

```sh
WTDC_IMAGE=my-local-arm64-image bash tests/real-e2e.sh
```
