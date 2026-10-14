# Batteries-included coding environment with Docker both ways: mounting the
# host socket (the default under the Dev Container CLI, via devcontainer.metadata
# below) selects docker-outside-of-docker; without it the entrypoint falls back
# to the Docker-in-Docker daemon for plain `docker run --privileged` use.
#
# FROM base, not node-bun-docker: the parent ships NodeSource nodejs and
# bun@latest, and this image replaces both with pinned versions. Docker layers
# only ever add bytes — a purge in a later layer whiteouts files but the pulled
# image still carries them — so inheriting them would bake ~320MB of dead
# NodeSource + Bun layers into every pull. The Docker stack, cloudflared, gh,
# and dev-group wiring are replicated here instead; the daemon branch of
# docker-init.sh still mirrors images/node-bun-docker/docker-init.sh.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
ARG NODE_VERSION=24.18.0
ARG BUN_VERSION=1.4.2
ARG TOFU_VERSION=1.12.0
ARG GITLEAKS_VERSION=8.30.1
ARG TYPOS_VERSION=1.35.5
ARG OASDIFF_VERSION=1.17.0

USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash git make curl jq gnupg ca-certificates coreutils findutils grep sed gawk \
      procps util-linux iproute2 tar gzip unzip xz-utils sudo \
      # nvim needs fd for Telescope file picking; Ubuntu names the binary fdfind.
      # socat proxies the host docker socket when its gid matches neither root
      # nor the docker group — the upstream docker-outside-of-docker feature's
      # fallback, replicated here.
      fd-find socat; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    install -m 0755 -d /etc/apt/keyrings; \
    # Repos copied from images/node-bun-docker: Cloudflare, Docker, GitHub CLI.
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg; \
    chmod a+r /etc/apt/keyrings/cloudflare-main.gpg; \
    printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
      "$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")" \
      "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
      "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh cloudflared \
      docker-ce docker-ce-cli containerd.io iptables docker-buildx-plugin docker-compose-plugin; \
    usermod -aG docker "${USER_NAME}"; \
    printf '\n# Load approved .envrc files in interactive Bash shells.\neval "$(direnv hook bash)"\n' >> "/home/${USER_NAME}/.bashrc"; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 install-pinned-tools.sh install-agent-tools.sh install-editors.sh compress-binaries.sh /usr/local/share/vibecode-essential/
RUN /usr/local/share/vibecode-essential/install-pinned-tools.sh
RUN /usr/local/share/vibecode-essential/install-agent-tools.sh
RUN /usr/local/share/vibecode-essential/install-editors.sh

# oh-my-bash + ble.sh + the compact-agnoster prompt theme + git aliases, wired
# into dev's .bashrc — the same feature meltiply applies per-workspace, baked
# in here so every worktree gets it without a feature build.
COPY oh-my-bash/ /usr/local/share/vibecode-essential/oh-my-bash/
RUN OHMYBASHVERSION=master BLEVERSION=v0.4.0-devel3 \
    _REMOTE_USER="${USER_NAME}" _REMOTE_USER_HOME="/home/${USER_NAME}" \
    /usr/local/share/vibecode-essential/oh-my-bash/install.sh

# --only-shell installs the headless shell only: the headed Chromium binary
# (~390MB) can never draw in a container without Xvfb, and Playwright's default
# headless launch uses the shell. `chromium` on PATH still works.
RUN set -eux; \
    npm install --global playwright@latest; \
    playwright install --with-deps --only-shell chromium; \
    ln -sfn /usr/local/lib/node_modules /node_modules; \
    shell_path="$(find "${PLAYWRIGHT_BROWSERS_PATH}" -name chrome-headless-shell -type f | head -1)"; \
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$shell_path" > /usr/local/bin/chromium; \
    chmod 0755 /usr/local/bin/chromium; \
    chmod -R a+rX /usr/local/lib/node_modules/playwright "${PLAYWRIGHT_BROWSERS_PATH}"; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/*

# Last: compress the big self-contained binaries once everything is installed.
RUN /usr/local/share/vibecode-essential/compress-binaries.sh

COPY --chmod=0755 smoke.sh /usr/local/share/vibecode-essential-smoke.sh
COPY --chmod=0755 docker-init.sh /usr/local/share/docker-init.sh
# docker.sock is a symlink to the host-socket mount point, baked in because the
# CLI runs the entrypoint as dev, who cannot write /var/run. With no host
# socket mounted the link is dead and the init's DinD branch unlinks it before
# dockerd binds. No placeholder at docker-host.sock: a file there would make
# the entrypoint pick the outside-of-docker path against a non-socket.
RUN ln -s /var/run/docker-host.sock /var/run/docker.sock


# DooD parity with ghcr.io/devcontainers/features/docker-outside-of-docker:
# the CLI mounts the host socket and replaces the image entrypoint with
# docker-init.sh, which proxies or gid-matches it for dev — no feature build,
# no privileged mode. DinD still works for plain `docker run --privileged`,
# which is why VOLUME declarations stay out: anonymous volumes would be
# created with nothing in them under the CLI.
LABEL devcontainer.metadata='[{"id":"ghcr.io/devcontainers/features/docker-outside-of-docker:1","securityOpt":["label=disable"],"entrypoint":"/usr/local/share/docker-init.sh","mounts":[{"source":"/var/run/docker.sock","target":"/var/run/docker-host.sock","type":"bind"}],"customizations":{"vscode":{"extensions":["ms-azuretools.vscode-containers"],"settings":{"github.copilot.chat.codeGeneration.instructions":[{"text":"This dev container includes the Docker CLI (`docker`) pre-installed and available on the `PATH` for running and managing containers using the Docker daemon on the host machine."}]}}}}]'

ENTRYPOINT ["/usr/local/share/docker-init.sh"]
CMD ["sleep", "infinity"]

USER ${USER_NAME}
WORKDIR /workspaces
