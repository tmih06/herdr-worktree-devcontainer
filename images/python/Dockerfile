# Python template: the base image plus uv and a current CPython.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
USER root

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/workspaces/.venv \
    PATH="/home/${USER_NAME}/.local/bin:${PATH}"

# uv is installed *as the workspace user*, not as root.
#
# The installer puts itself in `$HOME/.local/bin`, and root's home is /root — so installing
# it as root put uv in /root/.local/bin, where the PATH above does not look and the
# container user cannot read. The image claimed to contain uv, the table in images/README.md
# said so, and `uv` was not on PATH and could not be run. Nothing in a container image
# announces a tool that is quietly in the wrong home directory.
#
# Installing under the user's own home is also the only arrangement where a later
# `uv tool install` or `uv self update` by that user writes somewhere it is allowed to.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 python3-venv python3-pip; \
    rm -rf /var/lib/apt/lists/*; \
    su -s /bin/sh "${USER_NAME}" -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'; \
    test -x "/home/${USER_NAME}/.local/bin/uv"; \
    "/home/${USER_NAME}/.local/bin/uv" --version; \
    chown -R ${USER_NAME}:${USER_NAME} "/home/${USER_NAME}"

USER ${USER_NAME}
WORKDIR /workspaces
