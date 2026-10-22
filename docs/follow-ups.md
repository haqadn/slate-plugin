# Follow-ups

These were found in review and left out of this release. They are ordered by impact.

| # | Issue | Fix |
|---|---|---|
| 1 | A memory write that fails or is killed part way never leaves an item in no file, but it can leave one live and retired, or live in two files (a move or demotion cut short). No later apply removes the extra copy. | When an apply finds a live ID that's also retired, or live twice, keep one copy. |
| 2 | When several sessions share one process (not seen so far), a new session's start releases another slate session's process ID. That session's `/clear` then loses slate. | Use a SessionEnd(`clear`) marker that names the exact folder. |
| 3 | If a stopped curator outlives the 5s abort wait, its lock moves with the folder. The new session's drain then waits for the next Stop, and the memory block says "still updating". | Re-signal, or recheck the lock after a short delay. |
| 4 | `acquire` can return null with no holder: it spends its attempts removing a dead lock. The drain then waits for the next hook. | Try once more after removing a dead lock. |
| 5 | Lock takeover: a claimant that dies inside its claim window lets a second claimant remove a fresh lock. | Accepted for now. Closing it needs OS file locking. |
| 6 | A lenient retry drops an add whose topic op was invalid (`missing topic`). It's logged as a warning. | Put that add in `general` instead. |
| 7 | Item text has no length limit. One 3,100-char key fact demotes every other key item. | Cap item text, and refuse longer text as an error. |
| 8 | A hand-written bullet can't be retired the turn it appears: the curator sees it before it has an ID. | Adopt bullets (`applyChanges(dir, [])`) before building the first prompt. |
| 9 | `/slate:link` detaches the old session folder before `createSession`. If that fails, the session is left unlinked. | Linking again recovers. Or create first, then detach. |
| 10 | `/slate:done` treats an unreadable `session.json` as not live, so it can delete a slate a session still uses. | Treat an unreadable `session.json` as live. |
| 11 | `fs.link` needs hard links. On a filesystem without them, every lock attempt throws. The README says `SLATE_HOME` must support them. | Fall back to an exclusive create (`wx`). |
| 12 | `/branch` (`copySession`) copies stray `curator.lock.claim` and `.tmp` files. | Skip them when copying. |
| 13 | The startup sweep checks a folder's age, then deletes it. A session that becomes active in between is deleted. | Re-stat `session.json` just before deleting. |
| 14 | Claude Code 2.1.308 has no Grep/Glob tool, so agents grep the slate with Bash and may get a permission prompt. Widening auto-approval to Bash was left as the user's call. Recorded in `docs/acceptance.md`. | The user can add `~/slate` to `permissions.additionalDirectories` (README). Re-check on a newer Claude Code. |
| 15 | `rules.md` and `offload.md` say "Bash there is denied". That's only true in the default permission mode. | Say Bash there may be denied or prompt. |
| 16 | The migration tool ignores `createSlate`'s `created` flag, so two runs at once could copy into one slate. | Refuse when `created` is false. |
| 17 | A migration that fails mid-copy leaves a half-built slate. The next run refuses ("already exists") without saying to delete it. | Say so in the refusal, or build in a temp folder and rename. |
| 18 | The migration tool counts items by line shape and doesn't check content. | Run the real migration, then check `/slate:link` output and `curator.log`. |
| 19 | New item text that names a retired ID ("retired A320 aircraft") is refused as `tag in text`. The same pattern hides a hand-written line like that from injection. | Narrow `RETIRED_LIKE` to slate-shaped lines. |
| 20 | The slug-only topic index is kept while `now.md` and instructions are cut. | Drop the index to a pointer before cutting `now.md` or instructions. |
| 21 | The curator's retry prompt reuses the first attempt's topic index. | Rebuild the topic list for the retry. |
| 22 | A `slate:` line can have two "+N more" entries (key items, topic adds), and `rules.md` doesn't explain them. | Merge them, or name each. |
| 23 | A move strips `\r` from a CRLF line. | Keep the raw line when moving. |
| 24 | Reorganize: `describe()` has no `keep` case, so a keep prints as raw JSON. A `keep` then a `move` leaves a stale home. `--ops` doesn't check that the slate is unchanged since the dry run, though the accounting still catches a lost item. | Add the case. Clear the home on a move. Save file hashes with the plan and compare. |
| 25 | An absolute Glob pattern inside the slate now prompts. Usability only. | Allow it when the pattern's fixed prefix is inside the slate. |
| 26 | The link and done skills don't tell the model to reject a typed name containing `'`. The CLI's name check still rejects it. | Add one line to both `SKILL.md` files. |
| 27 | A turn that fails twice logs two warnings. | Skip the warning on the retry. |
| 28 | The rule that report pointers aren't facts has only been seen in the interactive run. | Rerun the `-p` acceptance (R3) to measure it. |
| 29 | The hand-back cap is 800 chars. The harness adds about 1,200 chars of wrapping, so a 785–800 char hand-back can pass the hook yet exceed 2,000 in total. | Lower the cap to about 700. |
| 30 | Under Linux, a 100k-char message made of multibyte text can exceed the 128KB single-argument limit. Only macOS was verified. | Pass the prompt to the curator through a file. |
| 31 | A lone `\r` or U+2028 in an offload return isn't split into a quoted line, so a Markdown viewer can show a fake `## t…` entry header. The `offloads.md` parser isn't fooled. | Split return text on `\r\n`, `\r`, `\n`, U+2028 and U+2029. |
| 32 | If another plugin's SubagentStop hook blocks a stop slate let through, slate writes two entries for that agent. Not seen live. | Let a later entry for the same agent win, or skip a repeat. |
| 33 | A background offload that finishes after `/clear` may report the old session ID, so its entry would be lost. Not verified. | Probe it; if so, find the folder by agent ID or process ID. |
| 34 | Live acceptance: a turn whose curator never settles fails no check, and check 1 depends on a ~1.1 s gap. | Fail on an unsettled curator. Order check 1's turns by event, not time. |
| 35 | Live acceptance: T3 matches slugs as substrings. T1a fails if any of several anchor items goes unnamed. `--recheck` finds checks by name prefix. The smoke-run record's list of dry-run vs real-run differences is incomplete. | Match `- <slug>.md`. Require one named anchor. Give checks stable IDs. Complete the list. |
| 36 | The live check finds offload agents through SubagentStop events, so an offload whose SubagentStop never fired goes unchecked. | Take the agent IDs from the main transcript's Agent calls. |
| 37 | Tests: a vacuous assert in `hook.test.mjs`: the SLATE_HOME test compares `root` with `env.SLATE_HOME`, which is set from it. The init-gone asserts sit inside the agent-frontmatter test in `packaging.test.mjs`. | Assert something real. Move the asserts to their own test. |
| 38 | Tests: `cli.test.mjs` uses `process.ppid` as an "alive" PID, which is the test runner. | Spawn a sleeper process. |
| 39 | Tests: the unlinked-session permission test covers Read only, not Write, Grep or Glob. The sweep test's `output !== undefined` assert is weak. | Cover the other tools. Assert the output's content. |
| 40 | Probe leftovers outside the repo: `~/.claude/session-env/*` dirs, `~/.claude/plugins/data/slate-inline`, probe entries in `~/.claude.json`, and older `slate-*` temp dirs in `$TMPDIR` from earlier test runs. | Delete them by hand if you want. |
