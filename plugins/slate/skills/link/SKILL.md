---
name: link
description: Link this session to a shared slate (a topic folder in ~/slate/) and load the rules for keeping the main thread small.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/slate.mjs" list "${CLAUDE_SESSION_ID}"`

The output above starts with this session's state (`linked <name>` or `unlinked`), then lists the slates, most recent first, then the project and branch.

Pick the slate name:
- If the user gave one, it is `$ARGUMENTS`.
- Otherwise ask with AskUserQuestion: up to the three most recent slates above, plus one name you suggest from this conversation (or from the project and branch). The free-text option takes a new name.

Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/slate.mjs" link "${CLAUDE_SESSION_ID}" '<name>'` with Bash. Pass the name as typed, in single quotes (double quotes would expand `$(…)` or backticks before the CLI validates the name).

The first line of its output is the status:
- `linked`, `already-linked` or `switched`: reply with one line saying so, and nothing else: don't restate the rules. Follow the slate rules printed after it for the rest of this session.
- `confirm-create <name>` (maybe with `closest <existing>`): ask yes/no with AskUserQuestion whether to create a new slate with that name, naming the closest existing slate when there is one. On yes, rerun the same command with `--create` added.
- `error …`: tell the user the message and ask for another name.
