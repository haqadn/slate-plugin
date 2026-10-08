# Live acceptance

Run on 2026-10-07 (local time) with Claude Code **2.1.293**, macOS. **Result: all 8 checks pass, and the interactive `/clear` and `/compact` check passes.**

## Setup

- **Script:** `node test/live/acceptance.mjs --live`. `npm test` registers it as skipped.
- **Project:** a fresh temp dir outside the repo (`$TMPDIR/slate-acc-GxsSoL`) holding a fake repo of 200 files:
  - 12 files contain `TODO(perf)` in different comment styles (`//`, `#`, `/* */`, `<!-- -->`, `--`, `{/* */}`), with and without a colon, plus one `!!`.
  - Near misses: `todo(perf)`, `TODO(perf, alice)`, `FIXME(perf)`, `TODO(security)`, `TODO perf:`.
- **Main session:** `/Users/adnan/.local/share/claude/versions/2.1.293`, called directly rather than through the terminal-wrapper shim.
  - Flags on every turn: `-p <prompt> --plugin-dir <repo>/plugins/slate --model sonnet --setting-sources project,local --permission-mode acceptEdits --output-format json`.
  - Turn 1 used `--session-id 7ba82ce1-c859-4cf0-a546-63a146ed495a`. Turns 2–5 used `--resume` with that ID.
  - Env was limited to `HOME USER LOGNAME PATH SHELL TERM LANG TMPDIR`, so the parent session's `CLAUDE_*` and terminal vars stayed out. `PATH` still had the shim first.
  - `--setting-sources project,local` keeps the user's own plugins and hooks out, as in `docs/verified.md`. `acceptEdits` lets the offload agent write its report without a prompt.
- **Between turns:** the script polled every 0.75s, for at most 180s. It waited until `curator.lock` was gone, `curated.json` matched `session.json`'s turn and the size of that turn's file, and this held on two polls in a row.
- **Curator:** its default model (`sonnet`). No `curatorModel` was set.

## Checks

The main transcript is `~/.claude/projects/<slug>/7ba82ce1-….jsonl`. Sidechain entries are excluded.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Turn 3 used an Agent call with `slate:offload` | PASS | 1 call, `subagent_type: "slate:offload"`. It was the only Agent call in the session. |
| 2 | No main-thread `tool_result` over 2,000 chars | PASS | Only 1 tool_result in the whole session: the Agent launch notice, 1,106 chars. The search's own tool output stayed in the subagent. |
| 3 | No Agent input from turn 4 on matches `/\bnpm\b/` | PASS | 0 Agent calls in turns 4–5, so this check is vacuous: nothing needed offloading. |
| 4 | Live memory files don't match `/\bnpm\b/` | PASS | None of `instructions.md`, `assumptions.md`, `facts.md` or `now.md` match. |
| 5 | `superseded.md` matches `/\bnpm\b/` | PASS | `[I1 t1 retired t3]`, see below. |
| 6 | Turn-5 answer contains `pnpm` | PASS | `` `pnpm add lodash` `` |
| 7 | `stg-7.internal` is in live memory | PASS | `facts.md` F1 |
| 8 | `curator.log` has no `restored` or `error` lines | PASS | 5 `ok` lines, all on attempt 1 |

These cover the spec's four acceptance checks:
- The search went through offload (1, 2).
- No brief after the switch mentions npm (3).
- npm appears only in `superseded.md`, and the answer uses pnpm (4, 5, 6).
- The first message's detail is kept (7).

### Turn 3's brief (the only Agent call)

```
Read <dir>/instructions.md, facts.md, now.md. Task: Find every file under <project> that mentions "TODO(perf)"
(exclude the .slate folder), and summarize the patterns (what kinds of perf issues, where they cluster, recurring
themes). Write details to <dir>/reports/todo-perf.md. Return ≤10 lines.
```

The agent ran in the background. Its result came back as a `<task-notification>` of 2,274 chars, which is a user message, not a tool_result. The count was right: 12 exact `TODO(perf)` hits in 12 files.

## Answers

| Turn | Prompt | Answer |
|---|---|---|
| 1 | `/slate:init` | Slate is on for this session. |
| 2 | always npm; staging host is stg-7.internal | Noted: npm for all package-manager commands, and staging host is stg-7.internal. |
| 3 | find every `TODO(perf)`, summarize patterns | 12 hits in 12 files, plus grouped bullets with patterns (1,381 chars) |
| 4 | Change of plan: pnpm | Got it, pnpm from now on instead of npm. |
| 5 | What command installs lodash? | `` `pnpm add lodash` `` |

## Final memory files

`instructions.md`
```
# Instructions
- [I2 t3] For this project, use pnpm
```

`assumptions.md`
```
# Assumptions
```

`facts.md`
```
# Facts
- [F1 t1] The staging host is stg-7.internal (user)
- [F2 t2] 12 "TODO(perf)" mentions, one in each of 12 files, all on line 33; full list in .slate/7ba82ce1-c859-4cf0-a546-63a146ed495a/reports/todo-perf.md (search report)
- [F3 t2] The report's first line "12 hits? No: 11 files" is a leftover miscount; "12 hits across 12 files" is correct (search report)
- [F4 t2] Categories: Database 5, Frontend 3, Memory/algorithms 3, Caching 1; only urgent (`!!`) one is hard-coded pool size of 4 in src/db/pool.rs (search report)
- [F5 t2] The tag appears both with and without a colon, so grepping one form misses the other (search report)
```

`now.md`
```
Goal: find every file that mentions "TODO(perf)" and summarize the patterns.
Focus: search done and summarized (12 files; see F2-F5); themes: unbounded growth, orders entity in 3 hits, 8 of 12 under src/.
Open: none.
Next: await the user's follow-up (e.g. fix the urgent pool size in src/db/pool.rs).
```

`superseded.md`
```
# Superseded
- [I1 t1 retired t3] For this project, always give package-manager commands using npm (reason: user switched project to pnpm)
```

## `curator.log`

```
2026-10-08T01:41:20.305Z t1 ok: attempt 1, changed instructions.md, facts.md, now.md
2026-10-08T01:41:37.461Z t2 ok: attempt 1, changed now.md
2026-10-08T01:42:05.606Z t2 ok: attempt 1, changed facts.md, now.md
2026-10-08T01:42:21.868Z t3 ok: attempt 1, changed instructions.md, superseded.md
2026-10-08T01:42:32.612Z t4 ok: attempt 1, no change
```

- slate turns are one behind the script's turns, because `/slate:init` is not a turn.
- t2 ran twice: once for the interim "search started" answer, then again when the background agent's result grew the turn file.

## Timings

| Turn | `claude -p` wall | Wait for curator after exit | Curator runs (start → log line) |
|---|---|---|---|
| 1 `/slate:init` | 3.4 s | 0.8 s (none) | — |
| 2 npm + staging | 4.4 s | 12.8 s | t1: 11.8 s |
| 3 search | 25.3 s | 20.3 s | t2: 9.7 s (interim, during the turn), then 19.1 s |
| 4 pnpm | 4.7 s | 11.3 s | t3: 10.3 s |
| 5 lodash | 3.4 s | 7.5 s | t4: 6.6 s |

- Run starts are from `ps` samples taken every 0.3s.
- `total_cost_usd` from `-p` read 0.029, 0.092, 0.272, 0.292 and 0.304. The figure grows across resumes, so the main session cost about $0.30 in all.
- Curator cost isn't captured, because its stdout is discarded.

## Curator binary

The script sampled `ps` for children of this session's `curate.mjs` and read each child's executable with `lsof`. All 5 curator runs showed the same thing:

| argv[0] | Executable (lsof txt) | Flags |
|---|---|---|
| `/Users/adnan/.local/bin/claude` | `/Users/adnan/.local/share/claude/versions/2.1.293` | `-p … --model sonnet` |

- The curator ran the real binary, not the terminal-wrapper shim that is first on `PATH`.
- argv[0] is an absolute path, so it came from `CLAUDE_CODE_EXECPATH`. The `PATH` fallback would show the bare name `claude`.
- Claude Code set `CLAUDE_CODE_EXECPATH` to its launcher symlink `~/.local/bin/claude`, even though the session was started through the versioned path.

## Interactive `/clear` and `/compact` check

A Python `pty` script ran at 120×40 in a second fresh temp dir (`$TMPDIR/slate-pty-0jrcenc0`). It used the same binary, with `--plugin-dir <repo>/plugins/slate --model sonnet --setting-sources project,local`. The whole check took 64 s, and no trust dialog appeared.

| Step | Result | Evidence |
|---|---|---|
| `/slate:init` | PASS | Folder `3681dc40-…` was created. The reply was "slate is on for this session." |
| `remember: deploy only on Fridays` | PASS | The Stop hook wrote the answer. The curator settled in 11.4 s and wrote `- [I1 t1] deploy only on Fridays`. |
| `/clear` moves the folder | PASS | `3681dc40-…` → `ce99b436-…`. `session.json` has `from: "3681dc40-…"`, and the old folder is gone. |
| SessionStart(clear) reloads memory | PASS | The new transcript has a SessionStart `hook_additional_context` containing `# slate memory`, the rules, `# Instructions` with I1, and `# Now`. |
| First message after `/clear` gets the change line | PASS | The UserPromptSubmit attachment was `slate: offload heavy reads to slate:offload; reply briefly.` |
| The answer after `/clear` uses reloaded memory | PASS | To "What is our deploy rule?" it answered "Deploy only on Fridays.", recorded as turn 2 in the moved folder. Its curator settled in 6.1 s. |
| `/compact` reloads memory | PASS | The screen showed "Compacted" and "PreCompact … completed successfully". 10 s later the transcript had a SessionStart attachment starting `# slate memory` / `Memory below wins where it differs from the summary.`, with I1. |

The change line after `/clear` has only the reminder. SessionStart(clear) had just shown every item, and nothing changed before the next message.

## Observations (not failures)

- **The turn-3 answer was long.** The main thread restated the offload return as 1,381 chars of grouped bullets. The user asked for a summary, but the rules say short.
- **The offload return was long too.** It was 1,518 chars in 10 long lines, within the "≤10 lines" wording but not its intent.
- **Report noise reached memory.**
  - The offload report's first line contradicts itself ("12 hits? No: 11 files").
  - The main thread repeated that note, and the curator saved it as F3.
  - Likely cause: the curator records verified facts from the answer as written, and the agent left a draft line in its report.
- **The change line in `-p` mode shows only the reminder.** Each `--resume` fires SessionStart(resume), which injects the whole memory block and marks every item as seen. So a later turn has no `+I…` entries to show. This is expected.

## Cleanup

Removed after recording these results:

- `/private/var/folders/yn/n1h_qdds3g57ndq635ryl38w0000gn/T/slate-acc-GxsSoL`
- `/private/var/folders/yn/n1h_qdds3g57ndq635ryl38w0000gn/T/slate-pty-0jrcenc0`
- `~/.claude/projects/-private-var-folders-yn-n1h-qdds3g57ndq635ryl38w0000gn-T-slate-acc-GxsSoL`
- `~/.claude/projects/-private-var-folders-yn-n1h-qdds3g57ndq635ryl38w0000gn-T-slate-pty-0jrcenc0`
- `/private/tmp/claude-501/-private-var-folders-yn-n1h-qdds3g57ndq635ryl38w0000gn-T-slate-acc-GxsSoL` (task output)
- `/private/tmp/claude-501/-private-var-folders-yn-n1h-qdds3g57ndq635ryl38w0000gn-T-slate-pty-0jrcenc0` (task output)

Not removed, because they fall outside the cleanup ruling. All are harmless.

- Empty `~/.claude/session-env/` dirs: `7ba82ce1-c859-4cf0-a546-63a146ed495a`, `3681dc40-878a-4d6c-94f3-7b00d5bf2554`, `ce99b436-523c-4dee-b89a-ada36fff9091`.
- Mentions of the two temp paths in `~/.claude.json` (project entries). That file was left alone.
