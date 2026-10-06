#!/usr/bin/env bash
set -euo pipefail

case "$(dpkg --print-architecture)" in
  amd64) node_arch=x64; gitleaks_arch=x64; rust_arch=x86_64 ;;
  arm64) node_arch=arm64; gitleaks_arch=arm64; rust_arch=aarch64 ;;
  *) echo 'Only linux/amd64 and linux/arm64 are supported' >&2; exit 1 ;;
esac
arch="$(dpkg --print-architecture)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

# Node goes straight to /usr/local — the image is FROM base, so there is no
# NodeSource package to replace and nothing to purge.
node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"
curl -fsSLo node-checksums.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " ${node_archive}$" node-checksums.txt | sha256sum --check -
tar -xJf "$node_archive" -C /usr/local --strip-components=1
npm install --global "bun@${BUN_VERSION}" corepack@latest
corepack enable

# These projects publish both architectures and checksums with each release.
install_release() {
  local repo="$1" tag="$2" archive="$3" checksums="$4" binary="$5"
  local dir="$work/$binary"
  mkdir "$dir"
  (
    cd "$dir"
    curl -fsSLO "https://github.com/${repo}/releases/download/${tag}/${archive}"
    curl -fsSLo checksums.txt "https://github.com/${repo}/releases/download/${tag}/${checksums}"
    grep " ${archive}$" checksums.txt | sha256sum --check -
    tar -xzf "$archive"
    install -m 0755 "$binary" "/usr/local/bin/$binary"
  )
}
install_release opentofu/opentofu "v${TOFU_VERSION}" "tofu_${TOFU_VERSION}_linux_${arch}.tar.gz" "tofu_${TOFU_VERSION}_SHA256SUMS" tofu
install_release gitleaks/gitleaks "v${GITLEAKS_VERSION}" "gitleaks_${GITLEAKS_VERSION}_linux_${gitleaks_arch}.tar.gz" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" gitleaks
install_release oasdiff/oasdiff "v${OASDIFF_VERSION}" "oasdiff_${OASDIFF_VERSION}_linux_${arch}.tar.gz" checksums.txt oasdiff

# typos publishes self-contained musl binaries, including aarch64. The digest
# is read from the release page's embedded metadata — api.github.com
# rate-limits shared CI runner IPs to 60/hr and dies unpredictably mid-build;
# expanded_assets serves the same digests as ordinary HTML.
typos_asset="typos-v${TYPOS_VERSION}-${rust_arch}-unknown-linux-musl.tar.gz"
typos_re="$(printf '%s' "$typos_asset" | sed 's/\./\\./g')"
typos_sha="$(curl -fsSL "https://github.com/crate-ci/typos/releases/expanded_assets/v${TYPOS_VERSION}" \
  | grep -oE 'aria-label="Copy to clipboard digest for [^"]+"[^>]*value="sha256:[0-9a-f]+"' \
  | sed -n "s/.*digest for ${typos_re}\".*value=\"sha256:\([0-9a-f]*\)\".*/\1/p" | head -1)"
[ -n "$typos_sha" ] || { echo "ERROR: no sha256 digest for ${typos_asset} on the release page" >&2; exit 1; }
curl -fsSLo typos.tar.gz "https://github.com/crate-ci/typos/releases/download/v${TYPOS_VERSION}/${typos_asset}"
printf '%s  typos.tar.gz\n' "$typos_sha" | sha256sum --check -
mkdir typos
tar -xzf typos.tar.gz -C typos
install -m 0755 typos/typos /usr/local/bin/typos
npm cache clean --force
