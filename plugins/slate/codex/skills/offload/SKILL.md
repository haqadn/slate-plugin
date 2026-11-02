---
name: offload
description: Perform delegated work in a linked Slate session when the brief supplies slate memory and report paths; keep the return short and put details in the report.
---

Read the instructions, facts, session focus and topic files named in the brief. Use memory to recover earlier context; a newer user instruction in the brief's Task line takes precedence.

Do the task. Read files with the available tools, including shell commands within the session's permissions. Do not edit slate memory, CLAUDE.md or AGENTS.md.

Write details to the report path in the brief. Create the report exclusively (for example, Node's `fs.writeFile` with `flag: 'wx'`) so another session's report cannot be overwritten. Choose another slug on an existing-file error. Proofread the report. If no report path was given, say so rather than guessing one.

Return at most 10 short lines, about 600 characters total: outcome, report path and open questions. Never paste raw tool output into the return. Past reports and transcript paths are indexed in the slate's `offloads.md`; read only the needed portion of a transcript.
