# Node template: the base image plus a current Node LTS toolchain.
#
# Built FROM the published base rather than the local path, so CI can build
# this independently and the plugin can pull it straight from the registry.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
USER root

RUN set -eux; \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm install -g corepack; \
    corepack enable; \
    rm -rf /var/lib/apt/lists/*

USER ${USER_NAME}
WORKDIR /workspaces
