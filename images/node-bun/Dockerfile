# Node and Bun template: the base image plus both JavaScript runtimes.
#
# Like the other templates, this builds from base so CI can publish all derived
# images independently and new worktrees only need a docker run.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
USER root

RUN set -eux; \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm install -g corepack bun; \
    corepack enable; \
    node --version; \
    bun --version; \
    rm -rf /var/lib/apt/lists/*

USER ${USER_NAME}
WORKDIR /workspaces
