#!/usr/bin/env bash
# UPX-compress the large self-contained ELF binaries. Measured on arm64:
# tofu 105→33MB, typos 27→7.8MB. A packed binary that fails self-test or
# --version is restored from backup, so a UPX-incompatible format degrades
# to "not compressed", never "broken".
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends upx-ucl file

pack() { # path verify-args...
  local bin="$1"; shift
  [ -f "$bin" ] || return 0
  case "$(file -b "$bin" 2>/dev/null || true)" in *ELF*) ;; *) return 0 ;; esac
  # bun --compile exes (`$bunfs` marker) embed assets that are read lazily
  # from their own on-disk image. UPX changes that layout, so the binary
  # still runs but bundled file reads return garbage — omp dies with
  # AgentParsingError on its embedded scout.md. --version cannot see this;
  # refuse to pack the class outright.
  if LC_ALL=C grep -aqm1 "\$bunfs" "$bin"; then
    printf 'skipped %s (bun-compiled, embeds lazy assets)\n' "$bin"
    return 0
  fi
  local size_before backup
  size_before=$(stat -c%s "$bin")
  backup="$(mktemp)"
  cp "$bin" "$backup"
  if upx -3 -q "$bin" 2>/dev/null \
     && upx -t -q "$bin" 2>/dev/null \
     && { [ $# -eq 0 ] || timeout 60 "$bin" "$@" >/dev/null 2>&1; }; then
    printf 'packed  %-58s %6.1fMB -> %6.1fMB\n' "$bin" \
      "$(awk "BEGIN{printf \"%.1f\", $size_before/1048576}")" \
      "$(stat -c%s "$bin" | awk '{printf "%.1f", $1/1048576}')"
  else
    cp "$backup" "$bin"
    printf 'skipped %s (UPX incompatible)\n' "$bin"
  fi
  rm -f "$backup"
}

# checksum-verified release binaries
pack /usr/local/bin/tofu version
pack /usr/local/bin/gitleaks version
pack /usr/local/bin/typos --version
pack /usr/local/bin/oasdiff --version
pack /usr/local/bin/codebase-memory-mcp --version
# bun-compiled: kept in the list so the guard prints an explicit skip.
pack /usr/local/bin/omp --version
pack /usr/local/bin/rtk --version
pack /usr/local/bin/lazydocker --version
pack /usr/local/bin/btop --version
pack /usr/local/bin/direnv version
pack /usr/local/bin/wakatime-cli --version
pack /usr/local/bin/circleci version
pack /usr/local/bin/yazi --version
pack /usr/local/bin/lazygit --version
pack /usr/local/bin/nvim --version
pack /usr/local/bin/node --version

# npm-delivered binaries (hardlinked siblings are repacked then relinked below)
pack /usr/local/lib/node_modules/bun/bin/bun.exe --version
pack /usr/local/lib/node_modules/opencode-ai/bin/opencode.exe --version
pack /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --version
pack /usr/local/lib/node_modules/wrangler/node_modules/workerd/bin/workerd --version
find /usr/local/lib/node_modules/@openai -name 'codex*' -type f -path '*bin*' \
  -exec file {} + 2>/dev/null | grep ELF | cut -d: -f1 | while read -r f; do pack "$f" --version; done

# apt-installed engines
for b in docker dockerd containerd ctr gh; do
  pack "/usr/bin/$b" --version 2>/dev/null || true
done
for b in /usr/libexec/docker/cli-plugins/docker-* /usr/bin/runc \
         /usr/bin/containerd-shim* /usr/local/bin/cloudflared; do
  pack "$b" version 2>/dev/null || true
done

# UPX writes a fresh inode, which would silently double every hardlinked pair
# (bun/bunx, the packaged exe and its bin/ twin). Re-link them after packing.
ln -f /usr/local/lib/node_modules/bun/bin/bun.exe /usr/local/lib/node_modules/bun/bin/bunx.exe 2>/dev/null || true
ln -f /usr/local/lib/node_modules/opencode-ai/bin/opencode.exe \
      /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-linux-*/bin/opencode 2>/dev/null || true
ln -f /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
      /usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-*/claude 2>/dev/null || true
ln -f /usr/local/lib/node_modules/wrangler/node_modules/workerd/bin/workerd \
      /usr/local/lib/node_modules/wrangler/node_modules/@cloudflare/workerd-linux-*/bin/workerd 2>/dev/null || true

apt-get purge -y upx-ucl  # file stays: yazi needs it for mime sniffing
apt-get autoremove -y --purge
rm -rf /var/lib/apt/lists/*

# Package docs/locales nobody reads inside a container.
rm -rf /usr/share/man /usr/share/info /usr/share/lintian /usr/share/linda \
       /var/cache/debconf/*-old /usr/share/doc/*/changelog* /usr/share/doc/*/NEWS* 2>/dev/null || true
