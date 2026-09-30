# Full JavaScript development template with a dedicated Docker-in-Docker daemon.
ARG BASE_IMAGE=ghcr.io/tmih06/herdr-devcontainer-base:latest
FROM ${BASE_IMAGE}

ARG USER_NAME=dev
USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends make direnv; \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm install -g corepack bun@latest; \
    corepack enable; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
      "$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")" \
      "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io iptables docker-buildx-plugin docker-compose-plugin; \
    usermod -aG docker "${USER_NAME}"; \
    git --version; \
    node --version; \
    bun --version; \
    docker --version; \
    dockerd --version; \
    docker compose version; \
    make --version; \
    direnv version; \
    printf '\n# Load approved .envrc files in interactive Bash shells.\neval "$(direnv hook bash)"\n' >> "/home/${USER_NAME}/.bashrc"; \
    rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 docker-init.sh /usr/local/share/docker-init.sh

# The CLI overrides Docker's entrypoint, so also record startup in image metadata.
# Storage is scoped to each dev container and kept outside its writable layer.
LABEL devcontainer.metadata='[{"privileged":true,"init":true,"entrypoint":"/usr/local/share/docker-init.sh","mounts":[{"source":"wtdc-dind-docker-${devcontainerId}","target":"/var/lib/docker","type":"volume"},{"source":"wtdc-dind-containerd-${devcontainerId}","target":"/var/lib/containerd","type":"volume"}]}]'

VOLUME ["/var/lib/docker", "/var/lib/containerd"]
ENTRYPOINT ["/usr/local/share/docker-init.sh"]

USER ${USER_NAME}
WORKDIR /workspaces
