# Python template: the base image plus uv and a current CPython.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
USER root

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/workspaces/.venv \
    PATH="/home/${USER_NAME}/.local/bin:${PATH}"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 python3-venv python3-pip; \
    rm -rf /var/lib/apt/lists/*; \
    curl -LsSf https://astral.sh/uv/install.sh | sh; \
    chown -R ${USER_NAME}:${USER_NAME} /home/${USER_NAME}

USER ${USER_NAME}
WORKDIR /workspaces
