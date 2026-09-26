# Rust template: the base image plus a rustup toolchain.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
USER root

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}

RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable; \
    chmod -R a+w ${RUSTUP_HOME} ${CARGO_HOME}

USER ${USER_NAME}
WORKDIR /workspaces

# Rust needs a linker, which is the one heavyweight thing worth pulling in here
# rather than in the base image.
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev; \
    rm -rf /var/lib/apt/lists/*
USER ${USER_NAME}
