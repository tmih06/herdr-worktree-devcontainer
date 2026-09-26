# Prebuilt base for the worktree-devcontainer plugin.
#
# The point of prebuilding: a devcontainer.json that declares `features` makes
# the devcontainer CLI derive a per-workspace image, so every new worktree pays
# for an image build. An image with no features is just `docker run`. So this
# image bakes in everything the plugin used to inject, and the generated config
# carries no features at all.
#
# Baked in:
#   - openssh-server, preconfigured for key-only auth, host keys generated at
#     build time so the first connection does not pay for ssh-keygen
#   - herdr, so postCreateCommand does not download 26MB per container
#
# Deliberately slim: no compiler, no language runtimes, no editors. Those live
# in the sibling templates so a base pull stays small. `build-essential` alone
# was ~250MB, which is most of why this used to be a heavy image.

FROM ubuntu:24.04

ARG HERDR_VERSION=0.9.1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-server \
      ripgrep \
      sudo \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# The workspace user. `dev`, deliberately: it is not tied to any editor, and
# the plugin discovers whichever user postCreateCommand ran as rather than
# assuming a name, so this is only a default.
ARG USER_NAME=dev
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd -g ${USER_GID} ${USER_NAME} 2>/dev/null || true \
 && useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash ${USER_NAME} \
 && mkdir -p /workspaces && chown ${USER_UID}:${USER_GID} /workspaces \
 && echo "${USER_NAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-${USER_NAME}

# sshd: key-only, root allowed, host keys generated now rather than on boot.
RUN mkdir -p /var/run/sshd /etc/ssh \
 && ssh-keygen -A \
 && printf '%s\n' \
      'PermitRootLogin yes' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PubkeyAuthentication yes' \
      'UsePAM yes' \
      'X11Forwarding no' \
      'AcceptEnv LANG LC_*' \
      > /etc/ssh/sshd_config.d/10-herdr.conf

COPY ssh-init.sh /usr/local/share/ssh-init.sh
RUN chmod +x /usr/local/share/ssh-init.sh

# herdr, baked in. The plugin bind mounts a host copy when it can and only
# falls back to installing when this is absent.
RUN set -eux; \
    curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh; \
    USER_NAME=${USER_NAME} sh /tmp/herdr-install.sh; \
    rm -f /tmp/herdr-install.sh; \
    cp "/home/${USER_NAME}/.local/bin/herdr" /usr/local/bin/herdr; \
    chmod 0755 /usr/local/bin/herdr; \
    rm -rf "/home/${USER_NAME}/.local" "/home/${USER_NAME}/.cache"; \
    /usr/local/bin/herdr --version

USER ${USER_NAME}
WORKDIR /workspaces
EXPOSE 2222

ENTRYPOINT ["/usr/local/share/ssh-init.sh"]
CMD ["sleep", "infinity"]
