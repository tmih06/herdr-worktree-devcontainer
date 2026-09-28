# Prebuilt base for the worktree-devcontainer plugin.
#
# The point of prebuilding: a devcontainer.json that declares `features` makes
# the devcontainer CLI derive a per-workspace image, so every new worktree pays
# for an image build. An image with no features is just `docker run`. So this
# image bakes in everything the plugin used to inject, and the generated config
# carries no features at all.
#
# Baked in:
#   - herdr, so a container that wants to run agents does not download 26MB
#
# Deliberately slim: no compiler, no language runtimes, no editors. Those live
# in the sibling templates so a base pull stays small. `build-essential` alone
# was ~250MB, which is most of why this used to be a heavy image. Nothing here
# listens on a port: the plugin enters the container with `docker exec`.

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
      ripgrep \
      sudo \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# The workspace user. `dev`, deliberately: it is not tied to any editor, and
# the plugin discovers whichever user postCreateCommand ran as rather than
# assuming a name, so this is only a default.
ARG USER_NAME=dev

# uid 1000, deliberately, and `ubuntu` has to move out of the way first.
#
# The devcontainer CLI rewrites the image so the container user's uid matches
# the host's, producing the `vsc-...-uid` copy. But its updateUID script
# refuses to remap when some other user already holds the target uid:
#
#   elif [ "$OLD_UID" != "$NEW_UID" -a -n "$EXISTING_USER" ]; then
#       echo "User with UID exists ($EXISTING_USER=$NEW_UID)."
#
# ubuntu:24.04 ships a `ubuntu` user at 1000, so the remap declined, the -uid
# image was a byte-identical copy, and `dev` stayed 1001 while the bind mount
# was owned by 1000. Nothing inside the container could be written.
#
# Giving `dev` uid 1000 and removing the squatter makes the remap a genuine
# no-op on a uid-1000 host, and still correct on any other host, where it can
# now actually do its job.
RUN set -eux; \
    # Delete rather than rename: the stock user has no home directory in this
    # minimal image, so `usermod -m` has nothing to move and fails.
    squatter="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$squatter" ] && [ "$squatter" != "${USER_NAME}" ]; then \
      userdel -r "$squatter" 2>/dev/null || userdel "$squatter" 2>/dev/null || true; \
    fi; \
    oldgroup="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$oldgroup" ] && [ "$oldgroup" != "${USER_NAME}" ]; then \
      groupdel "$oldgroup" 2>/dev/null || true; \
    fi; \
    getent group 1000 >/dev/null || groupadd -g 1000 "${USER_NAME}"; \
    id -u "${USER_NAME}" >/dev/null 2>&1 || \
      useradd -m -u 1000 -g 1000 -s /bin/bash "${USER_NAME}"; \
    mkdir -p /workspaces; \
    chown "${USER_NAME}:${USER_NAME}" /workspaces; \
    printf '%s\n' "${USER_NAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${USER_NAME}"; \
    chmod 0440 "/etc/sudoers.d/90-${USER_NAME}"; \
    test "$(id -u "${USER_NAME}")" = "1000"

# The plugin reads these labels to decide whether the uid remap is needed at
# all, which is what keeps a useless 300MB -uid copy from being built.
LABEL devcontainer.remote.user="${USER_NAME}" \
      devcontainer.remote.uid="1000"

# No sshd and no Herdr server are baked in. The plugin reaches the container
# with `docker exec` through the shell dispatcher, so there is no SSH endpoint
# to publish and no in-container Herdr to install. What this image still has to
# get right is the uid: the CLI's updateUID script refuses to remap when another
# user already holds the target uid, which is what left the bind-mounted
# worktree unwritable. That is handled above.
#
# herdr, however, is still needed *inside* the container for the user to run
# agents there, so it is installed plainly and without the sshd plumbing.
RUN set -eux; \
    curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh; \
    chmod +x /tmp/herdr-install.sh; \
    su -s /bin/sh "${USER_NAME}" -c 'sh /tmp/herdr-install.sh'; \
    rm -f /tmp/herdr-install.sh; \
    cp "/home/${USER_NAME}/.local/bin/herdr" /usr/local/bin/herdr; \
    chmod 0755 /usr/local/bin/herdr; \
    rm -rf "/home/${USER_NAME}/.local" "/home/${USER_NAME}/.cache"; \
    /usr/local/bin/herdr --version

USER ${USER_NAME}
WORKDIR /workspaces

CMD ["sleep", "infinity"]
