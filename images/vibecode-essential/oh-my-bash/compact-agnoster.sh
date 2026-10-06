#!/usr/bin/env bash
# Source after oh-my-bash's agnoster theme. Keep its Powerline colors and
# status markers, but omit user@host, display only the directory basename,
# and shorten worktree/<name> branches to <name>. Hide the branch label when
# the directory already identifies it; keep other branches and detached IDs.
AG_NO_CONTEXT=1

# Uses Bash's basename prompt escape so deep workspace paths occupy one segment.
# Home still renders as ~, and / still renders as /; no subprocess is needed.
prompt_dir() {
	prompt_segment blue black '\W'
}

# Preserves agnoster's dirty/stash colors and markers. Shorten worktree/<name>
# and omit the label at a matching worktree-<name> directory, but show it in
# subdirectories or on other branches. Detached HEAD retains its tag/commit;
# outside Git no segment is drawn.
prompt_git() {
	local ref dirty stash
	_omb_prompt_git rev-parse --is-inside-work-tree &>/dev/null || return 0
	if ref=$(_omb_prompt_git symbolic-ref --quiet --short HEAD 2>/dev/null); then
		ref="${ref#worktree/}"
		if [[ "${PWD##*/}" == "worktree-$ref" || "${PWD##*/}" == "$ref" ]]; then
			ref=""
		else
			ref=" $ref"
		fi
	else
		ref=$(_omb_prompt_git describe --exact-match --tags HEAD 2>/dev/null) ||
			ref=$(_omb_prompt_git rev-parse --short HEAD 2>/dev/null)
		ref="➦ $ref"
	fi
	dirty=$(git_status_dirty)
	stash=$(git_stash_dirty)
	if [[ -n $dirty ]]; then
		prompt_segment yellow black
	else
		prompt_segment green black
	fi
	PR+="$ref$stash$dirty"
}
