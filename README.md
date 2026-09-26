# worktree-devcontainer

A Herdr plugin that gives every new worktree a dev container, and connects that
container to your host Herdr as a saved SSH machine.

When you create a worktree in Herdr, this plugin notices, asks whether you want
a container, and if you say yes it will:

1. build and start a dev container from **your repo's own** `.devcontainer` config,
2. install `sshd` and `herdr` inside it,
3. publish the SSH port back to your host,
4. register the container in Herdr as a saved machine.

The worktree then appears in the sidebar as its own machine. Switch to it and
you are inside the container, running a container-side Herdr server, with your
agents and panes intact. Remove the worktree and the container goes with it.

## Requirements

| Tool | Why | Install |
|---|---|---|
| `docker` | runs the container | your package manager |
| `devcontainer` | the Dev Container CLI | `npm i -g @devcontainers/cli` |
| `jq`, `ssh`, `ssh-keygen`, `node`, `timeout` | config merge, SSH auth, JSONC parsing | `jq` `openssh` `nodejs` `coreutils` |

`node` is listed because the Dev Container CLI is an npm package, so it is
already on your machine wherever `devcontainer` runs.

## Install

```sh
herdr plugin link /path/to/this/repo
herdr plugin list                     # confirm no warnings
herdr plugin config-dir worktree-devcontainer
```

Then edit the config it printed:

```sh
$(herdr plugin config-dir worktree-devcontainer)/config.env
```

## Use it

Nothing to configure beyond your repo's `.devcontainer/devcontainer.json`.

Create a worktree the way you normally do (`prefix+shift+g`, or
`herdr worktree create`). As soon as it exists, an overlay asks:

```
  Dev container

  Worktree   feat-payments
             /home/you/.herdr/worktrees/feat-payments
  Config     .devcontainer/devcontainer.json
  Repo       myrepo

  [x] Create a dev container for this worktree

  y/Enter yes    n/Esc/q no    space toggle
```

Answer yes and a new tab opens in that workspace and streams
`devcontainer up`, so you watch the image build where you created the worktree.

### Actions

Also available from Herdr's action menu or `herdr plugin action invoke`:

| Action | What it does |
|---|---|
| `worktree-devcontainer.provision` | build a container for the current worktree |
| `worktree-devcontainer.status` | list tracked containers and whether they run |
| `worktree-devcontainer.teardown` | destroy the current worktree's container |

### Keybinding (optional)

```toml
[[keys.command]]
key = "prefix+shift+d"
type = "plugin_action"
command = "worktree-devcontainer.provision"
description = "dev container for this worktree"
```

## Configuration

All keys live in `config.env`. Precedence is **environment > config file >
shipped default**, so anything can be overridden per-invocation:

```sh
WTDC_ON_CREATE=auto bash bin/wtdc hook-created
```

| Key | Default | Meaning |
|---|---|---|
| `WTDC_ENABLED` | `1` | master switch for hooks and actions |
| `WTDC_ON_CREATE` | `prompt` | `prompt`, `auto`, or `never` |
| `WTDC_SSH_FEATURE` | `ghcr.io/devcontainers/features/sshd:1` | feature providing sshd |
| `WTDC_SSH_PORT` | `2222` | container port sshd listens on |
| `WTDC_CONTAINER_INSTALL` | herdr install script | run in the container's `postCreateCommand` |
| `WTDC_REMOTE_SESSION` | *(empty)* | named Herdr session inside the container |
| `WTDC_OPEN_REMOTE_WORKSPACE` | `1` | open a workspace in the container after connecting |
| `WTDC_READY_TIMEOUT` | `180` | seconds to wait for sshd and the container herdr server |
| `WTDC_BUILD_TIMEOUT` | `1800` | seconds to wait for `devcontainer up` |
| `WTDC_KEEP_CONTAINER` | `0` | keep the container when the worktree is removed |
| `WTDC_EXTRA_MOUNTS` | *(empty)* | extra `--mount` args, e.g. `type=bind,source=/a,target=/a` |
| `WTDC_CONFIG_CANDIDATES` | `.devcontainer/devcontainer.json .devcontainer.json` | where to look, relative to the worktree |
| `WTDC_MACHINE_LABEL_PREFIX` | `devc` | sidebar label prefix |

## How it works, and why

Three constraints drive the whole design. All three are properties of Herdr and
the Dev Container CLI, not choices.

**Herdr machines are SSH-only.** There is no docker transport. A container can
only become a saved machine if it runs an SSH server, which is why the plugin
injects the `sshd` devcontainer feature into your config. That feature listens
on **2222**, not 22, which is why `WTDC_SSH_PORT` defaults to 2222.

**`devcontainer up` ignores `forwardPorts`.** Forwarding is implemented by
editor clients; the Dev Container CLI itself has no forwarding daemon. So the
port is published with `runArgs: ["--publish", "127.0.0.1::2222"]`, which asks
Docker for a free loopback port. The plugin reads the real port back with
`docker port`. If your config uses `dockerComposeFile`, `runArgs` does not
apply and the plugin says so instead of failing silently — publish the port in
your compose file, or use `WTDC_EXTRA_MOUNTS`.

**Background SSH never answers a prompt.** Herdr's machine connections do not
ask for passwords, so the container gets a dedicated keypair instead. The
plugin generates one keypair under its state dir, injects the public key into
the container's `authorized_keys` via `postCreateCommand`, and writes a
managed drop-in at `~/.ssh/config.d/herdr-worktree-devcontainer`. The host key
is accepted on first contact and the known-hosts file is plugin-private, so
your own `~/.ssh/known_hosts` is never touched.

The same `postCreateCommand` also installs herdr inside the container and the
plugin starts the container-side server itself. That is deliberate: when
`herdr machine add` runs it finds a compatible binary and a running server, so
it saves the profile without stopping to ask you to install or replace anything.
Two details matter there:

- The server is started with `setsid`. Herdr reports its
  `detached_server_daemon` capability as `getsid(0) == getpid()`, so a server
  left in the `docker exec` session is rejected with *"remote server is not
  ready for saved machines"*.
- Every container command runs as the provisioned `remoteUser`, not the image
  user. Started as root, the server would leave root-owned state in the user's
  home and the later SSH session would fail with `EACCES`.

Installing herdr during image setup needs network access, and that step ends in
`|| echo` so one flaky download cannot fail the whole build. If herdr turns out
to be missing afterwards, the plugin retries the same install against the
running container and, if that still fails, prints the installer log it kept at
`/tmp/wtdc-install.log`.

### Your config is never modified

The merged config is written to the plugin's state directory, not next to your
original. That is forced by the CLI, which refuses any `--config` file not
literally named `devcontainer.json`. Because the copy lives elsewhere, every
host-relative path in it (`build.context`, `build.dockerfile`, `extends`) is
rewritten to an absolute path first so the build still resolves correctly.

The upside is that your worktree stays completely clean — `git status` shows
nothing after provisioning.

`devcontainer.json` is JSONC and is parsed with a string-aware comment
stripper rather than a regex, so `//` inside URLs survives.

### What you see in the sidebar

Each provisioned worktree becomes a machine labelled `devc-<slug>`, and a
workspace is opened inside the container rooted at its remote workspace
folder. Workspaces, panes and agents on that machine belong to the container's
own Herdr server and survive your host Herdr restarting.

## Cleanup

`herdr worktree remove` fires `worktree.removed`, which removes the saved
machine profile, destroys the container, deletes the merged config, and rewrites
the SSH drop-in. Everything is keyed off the worktree path in
`$HERDR_PLUGIN_STATE_DIR/state.json`, so cleanup still works when the checkout
is already gone.

Set `WTDC_KEEP_CONTAINER=1` to keep the container and forget only the Herdr
wiring.

## Known limits

- **`postCreateCommand` must be a string or an array of strings.** The Dev
  Container CLI joins array items with a space and execs the result as one
  command line, so an array is not a usable way to append work. The plugin
  always emits a single string chained with `&&`, joining your existing array
  with `&&` if you had one. The object form cannot be merged without changing
  its meaning, so the plugin refuses it with an explanation rather than
  guessing.
- **Compose configs are rejected**, because `runArgs` cannot publish the SSH
  port there. Use a compose file with an explicit `ports:` mapping for sshd.
- **Git inside the container can be awkward.** A linked worktree's `.git` is a
  file pointing at the main repo, which the container may not be able to reach.
  If `git` misbehaves inside the container, mount the git common dir with
  `WTDC_EXTRA_MOUNTS`.
- **Docker Desktop (macOS/Windows)**: container IPs are not routable from the
  host, so the published port is mandatory. Linux hosts also fall back to the
  container's bridge IP when nothing is published.

## Tests

```sh
bash bin/wtdc selftest     # pure logic: JSONC, merge, state, ssh projection
bash tests/e2e.sh          # full provision/teardown/hooks vs stubbed host tools
bash tests/real-e2e.sh     # a real container, real sshd, real saved machine
```

`real-e2e.sh` needs docker, the Dev Container CLI, a linked plugin, and builds
an image. Point it at a CLI that is not on `PATH`:

```sh
DEVCONTAINER_CLI=/path/to/devcontainer bash tests/real-e2e.sh
```

It only ever removes containers whose workspace lives under its own temp
directory, so your own dev containers are left alone.

To try the plugin by hand, this repo is its own fixture: it has a
`.devcontainer/devcontainer.json` that deliberately omits everything the plugin
injects. Create a Herdr worktree from it and the prompt overlay will appear.

## Uninstall

```sh
herdr plugin unlink worktree-devcontainer
rm -f ~/.ssh/config.d/herdr-worktree-devcontainer
```

Remove the `Include ~/.ssh/config.d/*` line from `~/.ssh/config` by hand if
nothing else uses it.
