#!/usr/bin/env bash
# Editors: yazi, lazygit, neovim + LazyVim. All resolve latest upstream at build
# time. Runs as root during docker build; nvim config lands in dev's home.
set -euo pipefail

case "$(dpkg --print-architecture)" in
  amd64) yazi_arch=x86_64; lazygit_arch=x86_64; nvim_arch=x86_64 ;;
  arm64) yazi_arch=aarch64; lazygit_arch=arm64; nvim_arch=arm64 ;;
  *) echo 'Only linux/amd64 and linux/arm64 are supported' >&2; exit 1 ;;
esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

asset_sha() { # repo tag asset -> sha256, from the release page's embedded
  # digest list. api.github.com rate-limits shared CI runner IPs to 60/hr and
  # dies unpredictably mid-build; expanded_assets serves the same digests as
  # ordinary HTML. Paired by the clipboard-copy widget's aria-label + value.
  local sha re
  re="$(printf '%s' "$3" | sed 's/\./\\./g')"
  sha="$(curl -fsSL "https://github.com/$1/releases/expanded_assets/$2" \
    | grep -oE 'aria-label="Copy to clipboard digest for [^"]+"[^>]*value="sha256:[0-9a-f]+"' \
    | sed -n "s/.*digest for ${re}\".*value=\"sha256:\([0-9a-f]*\)\".*/\1/p" \
    | head -1)"
  if [ -z "$sha" ]; then
    echo "ERROR: no sha256 digest for $1@$2/$3 on the release page" >&2
    return 1
  fi
  printf '%s' "$sha"
}

# yazi — terminal file manager. Release zip ships the binary in an arch dir.
yazi_tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/sxyazi/yazi/releases/latest)"
yazi_tag="${yazi_tag##*/}"
yazi_archive="yazi-${yazi_arch}-unknown-linux-gnu.zip"
curl -fsSLO "https://github.com/sxyazi/yazi/releases/download/${yazi_tag}/${yazi_archive}"
printf '%s  %s\n' "$(asset_sha sxyazi/yazi "$yazi_tag" "$yazi_archive")" "$yazi_archive" | sha256sum --check -
unzip -q "$yazi_archive" -d yazi-dir
yazi_bin="$(find yazi-dir -name yazi -type f | head -1)"
install -m 0755 "$yazi_bin" /usr/local/bin/yazi
# ya is yazi's CLI companion (opens tabs/cwd in the running instance) if shipped.
ya_bin="$(find yazi-dir -name ya -type f | head -1 || true)"
if [ -n "$ya_bin" ]; then install -m 0755 "$ya_bin" /usr/local/bin/ya; fi
# not lazygitrs.
lg_tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/jesseduffield/lazygit/releases/latest)"
lg_tag="${lg_tag##*/}"
lg_archive="lazygit_${lg_tag#v}_Linux_${lazygit_arch}.tar.gz"
curl -fsSLO "https://github.com/jesseduffield/lazygit/releases/download/${lg_tag}/${lg_archive}"
curl -fsSLo lg-checksums.txt "https://github.com/jesseduffield/lazygit/releases/download/${lg_tag}/checksums.txt"
grep " ${lg_archive}$" lg-checksums.txt | sha256sum --check -
mkdir lazygit && tar -xzf "$lg_archive" -C lazygit
install -m 0755 lazygit/lazygit /usr/local/bin/lazygit

# neovim — Ubuntu 24.04 ships 0.9.x, too old for LazyVim (needs >= 0.11).
nvim_tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/neovim/neovim/releases/latest)"
nvim_tag="${nvim_tag##*/}"
nvim_archive="nvim-linux-${nvim_arch}.tar.gz"
curl -fsSLO "https://github.com/neovim/neovim/releases/download/${nvim_tag}/${nvim_archive}"
printf '%s  %s\n' "$(asset_sha neovim/neovim "$nvim_tag" "$nvim_archive")" "$nvim_archive" | sha256sum --check -
tar -xzf "$nvim_archive" -C /usr/local --strip-components=1
# Convention over discovery: `vim` and `vi` run nvim.
ln -sf /usr/local/bin/nvim /usr/local/bin/vim
ln -sf /usr/local/bin/nvim /usr/local/bin/vi

# LazyVim starter into dev's config. Plugins sync headlessly; treesitter needs a
# compiler that is installed, used, and removed inside this one layer so the
# parser .so files are baked in but gcc is not.
DEV="${USER_NAME:-dev}"
user_home="/home/${DEV}"
NVIM=/usr/local/bin/nvim
su -s /bin/bash "$DEV" -c '
  set -e
  rm -rf ~/.config/nvim ~/.local/share/nvim ~/.local/state/nvim ~/.cache/nvim
  /usr/bin/git clone --depth=1 https://github.com/LazyVim/starter ~/.config/nvim
  rm -rf ~/.config/nvim/.git
'
apt-get update
apt-get install -y --no-install-recommends gcc tree-sitter-cli
su -s /bin/bash "$DEV" -c "
  set -e
  $NVIM --headless '+Lazy! sync' +qa
"
# Bake in the default LazyVim parser set. nvim-treesitter main returns a
# promise-like; fall back to TSInstallSync for older lockfile branches.
su -s /bin/bash "$DEV" -c "
  $NVIM --headless '+lua local ok=pcall(function() require(\"nvim-treesitter\").install({\"bash\",\"c\",\"css\",\"html\",\"javascript\",\"json\",\"lua\",\"markdown\",\"python\",\"regex\",\"tsx\",\"typescript\",\"vim\",\"vimdoc\",\"yaml\"},{summary=true}) end); if not ok then pcall(vim.cmd, \"silent! TSInstallSync bash c css html javascript json lua markdown python regex tsx typescript vim vimdoc yaml\") end' '+lua vim.defer_fn(function() vim.cmd(\"qa!\") end, 120000)' || true
"
if find "${user_home}/.local/share/nvim" -name '*.so' -path '*parser*' -print -quit 2>/dev/null | grep -q .; then
  echo 'treesitter parsers baked in'
else
  echo "WARN: no treesitter parsers prebuilt; first :TSUpdate needs 'sudo apt install gcc'" >&2
fi
apt-get purge -y gcc tree-sitter-cli
apt-get autoremove -y --purge
rm -rf /var/lib/apt/lists/* "${user_home}/.cache/nvim" "${user_home}/.local/state/nvim/log"

nvim --version | head -1
yazi --version
lazygit --version
