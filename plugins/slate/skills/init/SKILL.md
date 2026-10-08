---
name: init
description: Start slate for this session. Creates .slate/<session_id>/ and loads the rules for keeping the main thread small.
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" "${CLAUDE_SESSION_ID}"`

Follow the slate rules printed above for the rest of this session.
