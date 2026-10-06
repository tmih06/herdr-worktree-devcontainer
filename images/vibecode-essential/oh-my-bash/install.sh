#!/usr/bin/env bash
# Installs oh-my-bash and ble.sh into the remote user's home during the image
# build (runs as root; feature scripts provide _REMOTE_USER/_REMOTE_USER_HOME).
# Each tool is skipped when its version option (OHMYBASHVERSION / BLEVERSION)
# is empty. oh-my-bash is a shallow git clone; ble.sh's prebuilt release
# tarball is extracted with xz-utils into ~/.local/share/blesh, without a
# source build. The .bashrc block added at the end uses
# the upstream integration order: ble.sh is sourced with --attach=none BEFORE
# oh-my-bash so prompt/plugin setup lands inside the ble.sh session, and
# ble-attach runs last.
set -euo pipefail

TARGET_USER="${_REMOTE_USER:-dev}"
TARGET_HOME="${_REMOTE_USER_HOME:-/home/dev}"
export HOME="$TARGET_HOME"

# Shallow-clones $1 (repo path) at ref $2 into $3 as $TARGET_USER. Branches and
# tags clone directly; a 40-hex ref is treated as a commit and fetched by sha.
# `runuser` (util-linux) drops privileges without the PAM password prompt that
# `su` triggers for the passwordless `dev` account in this image.
install_repo() {
	local repo="$1" ref="$2" dest="$3"
	rm -rf "$dest"
	if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
		runuser -u "$TARGET_USER" -- bash -c "git init -q '$dest' && git -C '$dest' remote add origin 'https://github.com/${repo}.git' && git -C '$dest' fetch -q --depth 1 origin '$ref' && git -C '$dest' checkout -q FETCH_HEAD"
	else
		runuser -u "$TARGET_USER" -- git clone -q --depth 1 --branch "$ref" "https://github.com/${repo}.git" "$dest"
	fi
}
# Installs the selected framework ref and its compact agnoster overrides for
# the remote user. The overrides live outside the cloned framework so prompt
# customization does not modify upstream theme files.
install_oh_my_bash() {
	echo "oh-my-bash: installing $1 for $TARGET_USER"
	install_repo "ohmybash/oh-my-bash" "$1" "$TARGET_HOME/.oh-my-bash"
	install -D -m 0644 -o "$TARGET_USER" \
		"$(dirname "${BASH_SOURCE[0]}")/compact-agnoster.sh" \
		"$TARGET_HOME/.config/oh-my-bash/compact-agnoster.sh"
}

# Unpacks prebuilt ble.sh release $1 (e.g. v0.4.0-devel3). Upstream tarballs
# ship ble.sh already compiled at the archive root, so install is extract +
# strip-components into ~/.local/share/blesh — no make/gawk needed. Runs as
# $TARGET_USER so the tree ends up user-owned.
install_ble() {
	local ver="${1#v}"
	local tb="ble-${ver}.tar.xz"
	echo "ble.sh: installing $1 for $TARGET_USER"
	# xz-utils unpacks the .tar.xz release asset (no .tar.gz is published).
	command -v xz >/dev/null 2>&1 || {
		apt-get update -qq && apt-get install -y --no-install-recommends xz-utils
	}
	curl -fsSL --retry 3 --retry-delay 2 \
		-o "/tmp/$tb" "https://github.com/akinomyoga/ble.sh/releases/download/v${ver}/${tb}"
	runuser -u "$TARGET_USER" -- bash -c "mkdir -p '$TARGET_HOME/.local/share/blesh' && tar -xJf '/tmp/$tb' -C '$TARGET_HOME/.local/share/blesh' --strip-components=1"
	rm -f "/tmp/$tb"
}

# Refreshes only the marker-owned shell block, preserving surrounding user
# configuration. Install the requested Git aliases and load them after the
# framework so its defaults cannot override them; ble.sh attaches last.
write_bashrc() {
	local rc="$TARGET_HOME/.bashrc" scratch
	install -D -m 0644 -o "$TARGET_USER" \
		"$(dirname "${BASH_SOURCE[0]}")/git-aliases.sh" \
		"$TARGET_HOME/.config/oh-my-bash/git-aliases.sh"
	touch "$rc"
	scratch="$(mktemp)"
	awk '
		$0 == "# >>> omp-shell >>>" { managed = 1; next }
		$0 == "# <<< omp-shell <<<" { managed = 0; next }
		!managed { print }
		END { if (managed) exit 1 }
	' "$rc" >"$scratch"
	cat >>"$scratch" <<'EOF'

# >>> omp-shell >>>
# UTF-8 locale so ble.sh does not warn/fall back to byte-oriented editing.
: "${LANG:=C.utf8}"; export LANG

# ble.sh line editor: autosuggestions/auto-complete/syntax highlighting.
# --attach=none defers attach so oh-my-bash initializes inside the session.
[[ $- == *i* ]] && [[ -f ~/.local/share/blesh/ble.sh ]] && source ~/.local/share/blesh/ble.sh --attach=none

# Compact agnoster keeps Powerline colors and Git status without user@host
# or full workspace paths. Select a Nerd Font in the client terminal.
export OSH="$HOME/.oh-my-bash"
OSH_THEME="agnoster"
if [[ -f "$OSH/oh-my-bash.sh" ]]; then
	source "$OSH/oh-my-bash.sh"
	source "$HOME/.config/oh-my-bash/compact-agnoster.sh"
fi

# Requested Git shortcuts override any aliases defined by the framework.
source "$HOME/.config/oh-my-bash/git-aliases.sh"

# Attach ble.sh last, after all prompt/plugin setup (per upstream guide).
[[ ${BLE_VERSION-} ]] && ble-attach
# <<< omp-shell <<<
EOF
	cat "$scratch" >"$rc"
	rm -f "$scratch"
	chown "$TARGET_USER" "$rc"
}

[ -n "${OHMYBASHVERSION:-}" ] && install_oh_my_bash "$OHMYBASHVERSION"
[ -n "${BLEVERSION:-}" ] && install_ble "$BLEVERSION"
write_bashrc

echo "oh-my-bash feature: done (user=${TARGET_USER}, home=${TARGET_HOME})"
