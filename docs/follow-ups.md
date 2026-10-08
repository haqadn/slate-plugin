# Follow-ups

These were found in review and left out of v1. They are ordered by impact.

| # | Issue | Fix |
|---|---|---|
| 1 | Replies in the main thread run 500–800 chars after an offload, against the 2–3 lines `rules.md` asks for. The model doesn't fully follow it. | Tighten the wording, or add a Stop-hook nudge if it keeps happening. |
| 2 | New item text that names a retired ID (e.g. "confirms retired A2", "retired A320 aircraft") fails the safety check. The edit is restored after two tries, with a warning. | Add a curator rule against this, or narrow the `retired [IAF]\d+` pattern. |
| 3 | The `retired [IAF]\d+` pattern also hides a hand-written line like "retired A320" from injection. | Same as #2: narrow the pattern to slate-shaped lines. |
| 4 | When several sessions share one process (not seen so far), a new session's start releases another slate session's process ID. That session's `/clear` then loses slate. | Use a SessionEnd(`clear`) marker that names the exact folder. |
| 5 | If a stopped curator outlives the 5s abort wait, its lock moves with the folder. The new session's drain then waits for the next Stop, and the memory block says "still updating". | Re-signal, or recheck the lock after a short delay. |
| 6 | A curator could copy a plain line from `superseded.md` into an item file over several turns. Injection still filters it. | Leave `superseded.md` out of the malformed-line baseline. |
| 7 | A turn that fails twice logs two warnings. | Skip the warning on the retry. |
| 8 | The rule that report pointers aren't facts has only been seen in the interactive run. | Rerun the `-p` acceptance (R3) to measure it. |
| 9 | The hand-back cap is 800 chars. The harness adds about 1,200 chars of wrapping, so a 785–800 char hand-back can pass the hook yet exceed 2,000 in total. | Lower the cap to about 700. |
| 10 | Under Linux, a 100k-char message made of multibyte text can exceed the 128KB single-argument limit. Only macOS was verified. | Pass the prompt to the curator through a file. |
| 11 | Rare races: two processes taking over a dead lock at once; a copy that isn't atomic; `initSession` not crash-safe. | Harden them as needed. |
| 12 | Probe leftovers outside the repo: `~/.claude/session-env/*` dirs, `~/.claude/plugins/data/slate-inline`, probe entries in `~/.claude.json`, and older `slate-*` temp dirs in `$TMPDIR` from earlier test runs. | Delete them by hand if you want. |
