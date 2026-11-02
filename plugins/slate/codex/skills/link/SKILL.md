---
name: link
description: Link this Codex thread to a shared Slate memory folder and load its context. Use when the user asks to link or select a slate.
---

Resolve `../../../scripts/codex-slate.mjs` relative to this SKILL.md's directory and use that absolute path as `<cli>` below. Do not resolve it relative to the working directory or assume a plugin environment variable is set in shell tools.

1. Run `node "<cli>" list` in the current Codex thread's shell. The helper uses `CODEX_THREAD_ID`; if it is missing, report the error and stop. Never invent a session ID.
2. The first line says `linked <name>` or `unlinked`, followed by available slates (most recent first), project and branch. Use the name the user supplied. If none, offer recent slates and a suggested new name with the available question tool, or a concise chat question.
3. Run `node "<cli>" link '<name>'`. Names contain only lowercase letters, digits and hyphens (at most 64 characters). Reject other characters before building a shell command; never interpolate unvalidated user text.
4. On `confirm-create <name>` (possibly `closest <existing>`), ask whether to create it, mentioning the closest match. Only after yes, rerun with `--create`.
5. On `linked`, `already-linked` or `switched`, follow the printed rules and memory for this thread. Reply with one short status line; don't restate the rules. On `error`, explain it and ask for a valid name.

Resume and compaction reload linked memory through hooks. New and forked threads must link explicitly. The curator runs automatically after subsequent turns once the plugin hooks are trusted.
