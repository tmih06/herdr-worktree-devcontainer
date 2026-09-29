# Prebuilt images

Spinup is slow for one reason: a `devcontainer.json` that declares `features`
makes the Dev Container CLI derive a **per-workspace** image, so every new
worktree pays for an image build — roughly 25s even with every Docker layer
cached.

An image with **no features** is just `docker run`. So these images carry
what a container needs to be pleasant to work in, without a build step:

- `herdr`, so nothing is downloaded per container
- a `dev` user at uid 1000 owning `/workspaces` (not tied to any editor)

With one of these, the generated config has no `features`, the CLI builds
nothing, and a provision is a `docker run` plus a container start.

## Platforms

Every template is published for **linux/amd64 and linux/arm64**, as one
multi-arch tag, so Docker picks the right one for the host.

This matters more than it looks. The Dev Container CLI does not run your image
directly: when the container user's uid differs from the host's, it builds a
`vsc-…-uid` copy of the image first, and that build does `FROM` on the image and
runs a shell inside the copy. A copy this machine cannot execute fails there —
so an amd64-only tag on an Apple Silicon or ARM server does not fall back to
building from your config, it just breaks, and it breaks with `exec format
error` under twenty lines of minified stack trace.

Multi-arch publishes fix the common case. The other one is worth knowing about,
because it looks identical and is not the registry's fault: **a multi-arch tag
can still be on your machine as the wrong architecture.** A `pull --platform`,
a build run for another architecture, or a cache copied from another host all
leave the tag resolving locally to a variant that cannot run here. The plugin
checks the image it is about to use, says so before it starts, and gives you the
one command that fixes it:

```sh
docker pull --platform linux/arm64 ghcr.io/tmih06/herdr-devcontainer-node:latest
```

Linux only: a devcontainer is a Linux container, so there is no macOS or
Windows image to publish. `arm/v7` is left out deliberately — Herdr publishes
`linux-x86_64` and `linux-aarch64` only, and the base image installs it, so
there would be nothing to install on a 32-bit ARM host.

`verify` in the workflow runs every template on **both** architectures, on
native runners. Checking only on amd64 would mean the arm64 half is never
executed in CI, and a layer that fails to unpack there would surface on a user's
machine instead.

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

Naming a template **replaces** the `image` in your own `devcontainer.json` and
drops its `features`, which the plugin reports by name. `WTDC_TEMPLATE` is blank
by default for exactly that reason: a repo's own config is what runs unless it
asks otherwise. A repo that declares no features, or that names one of these
images itself, is on the fast path without any template configured.

## What's in each image

Sizes are the published `:latest` tags. Everything is inherited from `base`, so this
table is what each one *adds* — pick a row and you also get the first.

| | `base` | `node` | `python` | `rust` |
|---|---|---|---|---|
| **Size** | 67 MB | 138 MB | 106 MB | 360 MB |
| **Base OS** | Ubuntu 24.04 | ← | ← | ← |
| **User** | `dev`, uid 1000, NOPASSWD sudo | ← | ← | ← |
| **Workdir** | `/workspaces`, owned by `dev` | ← | ← | ← |
| **herdr** | 0.9.1 at `/usr/local/bin/herdr` | ← | ← | ← |
| git, curl, jq, ripgrep, less | ✅ | ← | ← | ← |
| ca-certificates, tzdata | ✅ | ← | ← | ← |
| **Node 24 LTS** + corepack | — | ✅ | — | — |
| **CPython 3** + venv + pip | — | — | ✅ | — |
| **`uv`** | — | — | ✅ | — |
| **rustup** stable, minimal profile | — | — | — | ✅ |
| `build-essential`, `pkg-config`, `libssl-dev` | — | — | — | ✅ |
| `RUSTUP_HOME`, `CARGO_HOME` on `PATH` | — | — | — | ✅ |
| `UV_PROJECT_ENVIRONMENT=/workspaces/.venv` | — | — | ✅ | — |

← means inherited from the column to the left, not absent. ✓ means added by that image.

Not in any of them, deliberately: **no compiler in `base`**, no language runtimes, no
editors, and no editor at all. `build-essential` alone was ~250MB, which was most of why
these images used to be heavy. Toolchains that genuinely need a linker pull their own
copy in — only `rust` does, which is why it is 5× the size of `base`.

Two environment details worth knowing, because they are set in the image rather than
left to the CLI:

- `UV_PROJECT_ENVIRONMENT=/workspaces/.venv` means `uv` puts venvs in the workspace,
  where the bind mount makes them persistent, instead of in `$HOME`.
- `RUSTUP_HOME`/`CARGO_HOME` are under `/usr/local` and world-writable, so `dev` can add
  toolchains without `sudo`.

The `dev` user and its uid are load-bearing rather than cosmetic. The Dev Container CLI
refuses to remap a uid that another user already holds, and `ubuntu:24.04` ships a
`ubuntu` user at 1000 — so `base` deletes it and gives `dev` that uid, which makes the
remap a genuine no-op on a uid-1000 host and still correct elsewhere. The image carries
`devcontainer.remote.uid` and `devcontainer.remote.user` labels so the plugin can skip
building a useless `-uid` copy of the image.

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
- **build-base** and **build** — `base` builds first and publishes on its own,
  because every other template is `FROM` it. **build** is then a matrix over
  the derived templates in parallel, each pulling `base` first. GHA layer cache
  is keyed per template, so a change to one does not invalidate the others.
- **verify** — after a successful push, runs `herdr --version` inside every
  published image, so a broken tag fails the workflow instead of failing
  someone's first provision.

Tags are `ghcr.io/tmih06/herdr-devcontainer-<name>:latest` by default; override
with the `workflow_dispatch` `tag` input. Pull requests build but do not push.

## Building locally

Usually pointless — that is the point of CI. When iterating on a Dockerfile:

```sh
docker build -t wtdc-base:local images/base
WTDC_IMAGE=wtdc-base:local bin/wtdc.mjs provision /path/to/worktree
```
