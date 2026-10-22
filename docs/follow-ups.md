# Follow-ups

These were found in review and left out of v1. They are ordered by impact.

| # | Issue | Fix |
|---|---|---|
| 1 | New item text that names a retired ID (e.g. "confirms retired A2", "retired A320 aircraft") fails the safety check. The edit is restored after two tries, with a warning. | Add a curator rule against this, or narrow the `retired [IAF]\d+` pattern. |
| 2 | The `retired [IAF]\d+` pattern also hides a hand-written line like "retired A320" from injection. | Same as #1: narrow the pattern to slate-shaped lines. |
| 3 | When several sessions share one process (not seen so far), a new session's start releases another slate session's process ID. That session's `/clear` then loses slate. | Use a SessionEnd(`clear`) marker that names the exact folder. |
| 4 | If a stopped curator outlives the 5s abort wait, its lock moves with the folder. The new session's drain then waits for the next Stop, and the memory block says "still updating". | Re-signal, or recheck the lock after a short delay. |
| 5 | A curator could copy a plain line from `superseded.md` into an item file over several turns. Injection still filters it. | Leave `superseded.md` out of the malformed-line baseline. |
| 6 | A turn that fails twice logs two warnings. | Skip the warning on the retry. |
| 7 | The rule that report pointers aren't facts has only been seen in the interactive run. | Rerun the `-p` acceptance (R3) to measure it. |
| 8 | The hand-back cap is 800 chars. The harness adds about 1,200 chars of wrapping, so a 785–800 char hand-back can pass the hook yet exceed 2,000 in total. | Lower the cap to about 700. |
| 9 | Under Linux, a 100k-char message made of multibyte text can exceed the 128KB single-argument limit. Only macOS was verified. | Pass the prompt to the curator through a file. |
| 10 | Rare races: two processes taking over a dead lock at once; a copy that isn't atomic; `initSession` not crash-safe. | Harden them as needed. |
| 11 | Probe leftovers outside the repo: `~/.claude/session-env/*` dirs, `~/.claude/plugins/data/slate-inline`, probe entries in `~/.claude.json`, and older `slate-*` temp dirs in `$TMPDIR` from earlier test runs. | Delete them by hand if you want. |
| 12 | A lone `\r` or U+2028 in an offload return isn't split into a quoted line, so a Markdown viewer can show a fake `## t…` entry header. The `offloads.md` parser isn't fooled. | Split return text on `\r\n`, `\r`, `\n`, U+2028 and U+2029. |
| 14 | If another plugin's SubagentStop hook blocks a stop slate let through, slate writes two entries for that agent. Not seen live. | Let a later entry for the same agent win, or skip a repeat. |
| 15 | The live check finds offload agents through SubagentStop events, so an offload whose SubagentStop never fired goes unchecked. | Take the agent IDs from the main transcript's Agent calls. |
| 16 | A background offload that finishes after `/clear` may report the old session ID, so its entry would be lost. Not verified. | Probe it; if so, find the folder by agent ID or process ID. |
| 17 | Claude Code 2.1.308 has no Grep/Glob tool, so an agent searching the slate with shell commands may get a permission prompt. Recorded in `docs/acceptance.md`. | Add `~/slate` to `permissions.additionalDirectories` (README), or re-check on a newer Claude Code. |
| 18 | The migration tool counts items by tag shape and does not validate content. | Run the real migration, then check `/slate:link` output and `curator.log`. |
