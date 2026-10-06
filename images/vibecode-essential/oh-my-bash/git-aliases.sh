#!/usr/bin/env bash
# Source after oh-my-bash so these shortcuts override framework defaults.
# Arguments are passed through: gc "message" → git commit -m "message";
# ga stages the current directory tree, respecting Git's ignore rules.
alias gs='git status'
alias gp='git push'
alias gpl='git pull'
alias gco='git checkout'
alias ga='git add .'
alias gc='git commit -m'
