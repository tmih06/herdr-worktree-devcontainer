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
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules

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

# Browsers live in the standard Playwright cache, and the package is installed in
# the global npm prefix. Node does not search that prefix on its own, so both
# resolution routes are provided: NODE_PATH for `require`, and a symlink at the
# filesystem root, which is the one `node_modules` every module path includes —
# that also makes `import 'playwright'` work from any directory, which NODE_PATH
# alone does not cover.
RUN set -eux; \
    npm install --global playwright@latest; \
    playwright install --with-deps chromium; \
    ln -sfn /usr/local/lib/node_modules /node_modules; \
    chromium_path="$(NODE_PATH=/usr/local/lib/node_modules node -p "require('playwright').chromium.executablePath()")"; \
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$chromium_path" > /usr/local/bin/chromium; \
    chmod 0755 /usr/local/bin/chromium; \
    chmod -R a+rX /usr/local/lib/node_modules/playwright /ms-playwright; \
    npm cache clean --force; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 smoke.sh /usr/local/share/vibecode-essential-smoke.sh

USER ${USER_NAME}
WORKDIR /workspaces
# ENTRYPOINT, CMD, DinD volumes, and devcontainer metadata are inherited unchanged.
