---
name: done
description: Delete a shared slate (its memory, reports and sessions) when the topic is finished.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/slate.mjs" list "${CLAUDE_SESSION_ID}"`

The output above starts with this session's state (`linked <name>` or `unlinked`).

The slate to delete is `$ARGUMENTS` if given, otherwise the slate this session is linked to. If neither exists, say so and stop.

Ask yes/no with AskUserQuestion, naming the slate and saying that its memory, reports and every session's notes are deleted for good. On no, stop.

On yes, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/slate.mjs" done "${CLAUDE_SESSION_ID}" <name> --yes` with Bash and report the first line of its output. On `refused <name> live <ids>`, name the live sessions: they must be closed or linked elsewhere first.
