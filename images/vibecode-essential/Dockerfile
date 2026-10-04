# Batteries-included coding environment, retaining the node-bun-docker DinD setup.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-node-bun-docker:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
ARG NODE_VERSION=24.18.0
ARG BUN_VERSION=1.4.2
ARG TOFU_VERSION=1.12.0
ARG GITLEAKS_VERSION=8.30.1
ARG TYPOS_VERSION=1.35.5
ARG OASDIFF_VERSION=1.17.0

USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash git make curl jq gnupg ca-certificates coreutils findutils grep sed gawk \
      procps util-linux iproute2 tar gzip unzip xz-utils sudo cloudflared \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
      "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 install-pinned-tools.sh install-agent-tools.sh /usr/local/share/vibecode-essential/
RUN /usr/local/share/vibecode-essential/install-pinned-tools.sh
RUN /usr/local/share/vibecode-essential/install-agent-tools.sh

# Browser artifacts are shared and readable by dev, not installed in root's home.
RUN set -eux; \
    npm install --prefix /opt/playwright playwright@latest; \
    ln -s /opt/playwright/node_modules/playwright/cli.js /usr/local/bin/playwright; \
    playwright install --with-deps chromium; \
    chmod -R a+rX /opt/playwright /opt/playwright-browsers; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 smoke.sh /usr/local/share/vibecode-essential-smoke.sh

USER ${USER_NAME}
WORKDIR /workspaces
# ENTRYPOINT, CMD, DinD volumes, and devcontainer metadata are inherited unchanged.
