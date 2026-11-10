#compdef claude-slate
# Tab completion for claude-slate: the first word completes to slate names.
# Source it from ~/.zshrc after compinit (oh-my-zsh runs compinit for you).
_claude_slate() {
  if (( CURRENT == 2 )); then
    local -a slates
    slates=(${SLATE_HOME:-$HOME/slate}/[a-z0-9]*(N/:t))
    compadd -- "${slates[@]}"
  else
    _files
  fi
}
if (( $+functions[compdef] )); then
  compdef _claude_slate claude-slate
fi
