# Worktree Dev Container

Run Herdr projects and Git worktrees in dev containers. Each checkout keeps its
place under the repository in the sidebar; its terminals, splits, tabs, and
agents run inside its container. Git works across linked worktrees, and a 🐳
marks container workspaces.

## Quick start

Requires **Herdr 0.9.0+**, **Docker**, **Node.js 22+**, and **Git**.

```sh
npm install -g @devcontainers/cli
herdr plugin link /path/to/this/repo
herdr plugin enable worktree-devcontainer
herdr plugin action invoke worktree-devcontainer.install-shell
```

The last command installs the shell dispatcher by updating `terminal.default_shell`
in `~/.config/herdr/config.toml`, backing up the file, and reloading Herdr. It is
required for new terminals to enter containers; elsewhere, it runs your usual shell.
The plugin has no runtime dependencies or build step.

Add `.devcontainer/devcontainer.json` to your repository, for example:

```json
{
  "name": "myproject",
  "image": "ghcr.io/tmih06/herdr-devcontainer-node:latest",
  "remoteUser": "dev",
  "postCreateCommand": "npm ci"
}
```

Create a worktree normally. The plugin asks whether to start its dev container,
shows the image and expected setup work, then opens a progress screen. When setup
finishes, that screen becomes the container terminal. `Esc` cancels setup; failures
show the error and log path while leaving the host shell available.

## Daily use

To open an existing project or worktree in a container, focus its workspace and run:

```sh
herdr plugin action invoke worktree-devcontainer.reopen-container
```

Use the same command with any action below:

| Action              | Result                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `reopen-container`  | Choose a config and start or reuse its container in a new tab.                 |
| `rebuild-container` | Rebuild and reopen, preserving named volumes.                                  |
| `reopen-host`       | Switch to host terminals and stop the container, keeping its data.             |
| `provision`         | Set up a container for the focused checkout.                                   |
| `status`            | Show tracked containers and whether they are running.                          |
| `teardown`          | Destroy the container and its owned Docker-in-Docker storage.                  |
| `remove-worktree`   | Clean up containers and owned storage, then remove the Git worktree.           |
| `cleanup`           | Retry interrupted cleanup and reclaim tracked resources for deleted worktrees. |

In the dialog, `y` or `Enter` accepts and `n` or `Esc` declines. Use `↑`/`↓` to
edit the image, **c** to switch between the main checkout's config and this
worktree's config, and **r** to rebuild. Config selection is remembered per checkout.
Editing the image keeps the config's features.

New panes follow the checkout's selected container or host mode. Reopening keeps
existing panes; rebuild after changing the config or its source. Returning to the
host and rebuilding both preserve Docker-in-Docker data; `teardown` deletes it.

## Configuration

The plugin reads `.devcontainer/devcontainer.json`, then `.devcontainer.json`.
By default it uses the **main checkout's file on disk**, including uncommitted
edits. Select **This worktree** in the dialog for branch-specific configuration,
or set `WTDC_CONFIG_SOURCE=worktree` as the default.

Your image, features, user, mounts, and lifecycle commands control the container.
The plugin waits for `postCreateCommand` and uses the branch as the hostname unless
you set one in `runArgs`. Prebuilt images avoid feature builds; matching local
feature builds and UID-adjusted images can be reused across worktrees. See the
[image reference](images/README.md) for available toolchains and Docker-in-Docker.

Herdr copies [the default settings](config/config.default.env) into its plugin
config directory on first use. Edit that copy; commonly used settings are:

| Setting                        | Default  | Purpose                                                      |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| `WTDC_ON_CREATE`               | `prompt` | Ask on worktree creation; also accepts `auto` or `never`.    |
| `WTDC_CONFIG_SOURCE`           | `main`   | Default config source: `main` or `worktree`.                 |
| `WTDC_BUILD_TIMEOUT`           | `1800`   | Setup timeout in seconds, including lifecycle commands.      |
| `WTDC_KEEP_CONTAINER`          | `0`      | Set to `1` to keep containers on automatic worktree removal. |
| `WTDC_HOSTNAME`                | `branch` | Use the branch, `off`, or a literal hostname.                |
| `WTDC_CONTAINER_ICON`          | `🐳`     | Sidebar marker; empty disables it.                           |
| `WTDC_TEMPLATE` / `WTDC_IMAGE` | empty    | Override the image and drop declared features.               |

For host tools and authentication mounts, see
[this repository's devcontainer config](.devcontainer/devcontainer.json).

## Worktree cleanup

Use `remove-worktree` for Docker cleanup before Git removal. If cleanup fails,
the checkout stays intact. User-defined volumes are preserved.

To get the same ordering with Herdr's native **Remove worktree**, run:

```sh
herdr plugin action invoke worktree-devcontainer.install-native-cleanup
```

This installs a Git launcher at `~/.local/bin/git`; that directory must precede
the original Git executable on the Herdr server's `PATH`. Without it, Herdr's
removal hook runs after Git has deleted the checkout. The plugin also retries
pending cleanup on startup; use `cleanup` to retry immediately.

## Development

```sh
npm ci
npm test
npm run lint
npm run format:check
bash tests/prompt-keys.sh  # dialog controls through a real PTY
bash tests/real-e2e.sh     # requires Docker, devcontainer, and a live Herdr
```

After editing `herdr-plugin.toml`, run `herdr server reload-config`.
