# Prebuilt images

Spinup is slow for one reason: a `devcontainer.json` that declares `features`
makes the Dev Container CLI derive a **per-workspace** image, so every new
worktree pays for an image build — roughly 25s even with every Docker layer
cached.

An image with **no features** is just `docker run`. So these images bake in
everything the plugin used to inject at provision time:

- `openssh-server`, key-only, host keys generated at build time
- `herdr`, so nothing is downloaded per container
- a `dev` user owning `/workspaces` (not tied to any editor)

With one of these, the generated config has no `features`, the CLI builds
nothing, and a provision is a `docker run` plus a container start.

## Using one

```sh
# by template name, resolved through manifest.json
export WTDC_TEMPLATE=node

# or straight at an image
export WTDC_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
```

In `config.env`:

```sh
WTDC_TEMPLATE=node
WTDC_IMAGE_REMOTE_USER=dev
```

The plugin pulls the image once if it is not local, so the first provision of a
template pays the pull and every one after that does not.

## Templates

| Template | Adds |
|---|---|
| `base` | Ubuntu 24.04, sshd, herdr, git, curl, jq, ripgrep, less, sudo |
| `node` | Node 24 LTS, corepack |
| `python` | CPython 3, `uv` |
| `rust` | rustup stable, `build-essential`, `pkg-config`, `libssl-dev` |

`base` is deliberately slim: no compiler, no language runtimes, no editors.
`build-essential` alone was ~250MB, which was most of why these images were
heavy. Toolchains that genuinely need a linker pull their own copy in
(`rust` does).

## Adding a template

1. Create `images/<name>/Dockerfile`, `FROM`ing the published base:

   ```dockerfile
   ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
   FROM ${BASE_IMAGE}
   ARG USER_NAME=dev
   USER root
   RUN apt-get update && apt-get install -y --no-install-recommends <pkgs> \\
       && rm -rf /var/lib/apt/lists/*
   USER ${USER_NAME}
   WORKDIR /workspaces
   ```

2. Add it to `manifest.json`. That file is the single source of truth: CI reads
   it to decide what to build, and the plugin reads it to resolve
   `WTDC_TEMPLATE`.

```json
{ "name": "go", "dir": "images/go", "base": "base", "description": "base plus Go" }
```

`base` is the only entry without a `base` field, and CI builds it first.

3. Push. The workflow builds everything on `main` and pushes to GHCR.

## CI

`.github/workflows/images.yml` has three jobs:

- **plan** — reads `manifest.json` and emits the build matrix. A broken manifest
  fails in seconds rather than after a base image has been through a full build.
- **build** — matrix, one job per template, parallel. `base` has no dependency
  so it is not blocked; the others pull `base` first. GHA layer cache keyed per
  template, so a change to one does not invalidate the others.
- **verify** — after a successful push, runs `herdr --version` inside every
  published image, so a broken tag fails the workflow instead of failing
  someone's first provision.

Tags are `ghcr.io/tmih06/herdr-devcontainer-<name>:latest` by default; override
with the `workflow_dispatch` `tag` input. Pull requests build but do not push.

## Building locally

Usually pointless — that is the point of CI. When iterating on a Dockerfile:

```sh
docker build -t wtdc-base:local images/base
WTDC_IMAGE=wtdc-base:local bin/wtdc provision /path/to/worktree
```
