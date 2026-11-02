---
name: done
description: Delete a finished shared slate and its memory, reports and session notes. Use only when the user asks to finish or delete a slate.
---

Resolve `../../../scripts/codex-slate.mjs` relative to this SKILL.md's directory and use that absolute path as `<cli>`. Run `node "<cli>" list` in the current Codex thread's shell. The helper reads `CODEX_THREAD_ID`; if it is missing, report the error and stop.

Use the slate name the user supplied, or this thread's linked slate. If neither exists, say so and stop. Names contain only lowercase letters, digits and hyphens (at most 64 characters). Reject any other characters before building a shell command.

Ask for confirmation, naming the slate and explaining that deletion permanently removes its memory, reports and every session's notes. Use an available question tool or a concise chat question. On no, stop.

On yes, run `node "<cli>" done '<name>' --yes` and report the first output line. On `refused <name> live <ids>`, explain that those sessions must end or link elsewhere first. If a Codex thread crashed, resume and end it normally to release its active marker. Do not bypass this guard or delete files manually.
