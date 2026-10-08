# Live acceptance

Run on 2026-10-07 (local time) with Claude Code **2.1.293**, macOS. In this document, `<tmp>` stands for `$TMPDIR` and `~` for the home dir.

**Result: not yet passing.**

| Run | Failed checks |
|---|---|
| Full run (6 turns, isolated settings) | 3 of 15: the subagent return is over 2,000 chars, and npm appears in a brief and in live memory, both caused by turn 6. |
| Real-settings pass (turns 1–3) | 3 of 10: the init reply was not one line, the subagent return is over 2,000 chars, and the hand-back was counted as a user turn. |

The interactive `/clear` and `/compact` check passed in round 0. It was not rerun in this round.

## Setup

- **Script:** `node test/live/acceptance.mjs --live [--real-settings]`. `npm test` registers it as skipped.
- **Project:** a fresh temp dir, `<tmp>/slate-acc-*`, holding a fake repo of 200 files.
  - 12 files contain `TODO(perf)` in different comment styles. Near misses: `todo(perf)`, `TODO(perf, alice)`, `FIXME(perf)`, `TODO(security)`, `TODO perf:`.
  - For turn 6 there are install commands in `scripts/setup.sh`, `Dockerfile` and `packages/web/package.json`. All use pnpm; none uses npm.
- **Main session:** the real binary `~/.local/share/claude/versions/2.1.293`, not the terminal-wrapper shim.
  - Every turn: `-p <prompt> --plugin-dir <repo>/plugins/slate --model sonnet --output-format json`.
  - Turn 1 used `--session-id <uuid>`. Later turns used `--resume <uuid>`.
  - Env was limited to `HOME USER LOGNAME PATH SHELL TERM LANG TMPDIR`. `PATH` still had the shim first.
- **Two profiles:**

| Profile | Extra flags | What loads |
|---|---|---|
| Isolated (default, 6 turns) | `--setting-sources project,local --permission-mode acceptEdits` | Only slate. Subagents can't use Bash. |
| Real settings (`--real-settings`, turns 1–3) | none | The user's plugins, hooks, CLAUDE.md and permission rules |

- **Between turns:** the script polled every 0.75s, for at most 180s. It waited until `curator.lock` was gone and `curated.json` matched both `session.json`'s turn and that turn file's size, on two polls in a row.
- **Curator:** its default model (`sonnet`).

**Turns:**
1. `/slate:init`
2. `For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.`
3. `Find every file that mentions "TODO(perf)" and summarize the patterns.`
4. `Change of plan: this project uses pnpm now.`
5. `What command installs lodash? Reply with only the command.`
6. `Scan every package.json and script in this repo and summarize the install commands they use.`

## Checks

The main transcript is `~/.claude/projects/<slug>/<uuid>.jsonl`, with sidechain entries excluded.

A subagent's return reaches the main thread in one of two ways:
- a `<task-notification>` user message, when the agent ran in the background
- an `<agent-message>` user message, when the agent used the hand-back tool, which happened under real settings

Check 4 counts both.

| # | Check | Full run | Real settings |
|---|---|---|---|
| 1 | `/slate:init` created the folder and replied in one line | PASS | **FAIL** |
| 2 | Turn 3 used an Agent call with `slate:offload` | PASS | PASS |
| 3 | No main-thread `tool_result` over 2,000 chars | PASS (max 1,106) | PASS (max 1,106) |
| 4 | No main-thread subagent return over 2,000 chars | **FAIL** (t3 1,830; t6 2,209) | **FAIL** (agent-message 2,096) |
| 5 | At least one Agent call after turn 4 | PASS (t6 `slate:offload`) | n/a |
| 6 | No Agent input from turn 4 on matches `/\bnpm\b/` | **FAIL** (the t6 brief) | n/a |
| 7 | Live memory files don't match `/\bnpm\b/` | **FAIL** (`facts.md` F9) | n/a |
| 8 | `superseded.md` matches `/\bnpm\b/` | PASS | n/a |
| 9 | Turn-5 answer contains `pnpm` | PASS: `` `pnpm add lodash` `` | n/a |
| 10 | `stg-7.internal` is in live memory | PASS | PASS |
| 11 | `curator.log` has no line matching `/\b(restored\|error)\b/i` | PASS | PASS |
| 12 | Every user turn got the slate change line | PASS (turns 2–6) | PASS (turns 2–3) |
| 13 | slate counted only user prompts as turns | PASS (5 for 5) | **FAIL** (3 for 2) |
| 14 | `curator.log` has an `ok` line for every slate turn | PASS (5 turns) | PASS (3 turns) |
| 15 | Offload report written, and no subagent Write/Edit failed | PASS | PASS |

Two things were added after the runs: the `<agent-message>` channel in check 4, and check 13. Both came out of this round's results, and neither run was repeated.
- Check 4's 2,096-char real-settings figure was measured on that run's transcript with the committed `analyse()`.
- Check 13 is computed from each run's `session.json` turn count.

## Failures

### Check 4: subagent returns are still over the cap

Evidence:
- **Full run, t3:** a `<task-notification>` of 1,830 chars, of which the `<result>` is 1,074.
- **Full run, t6:** 2,209 chars, of which the result is 1,447.
- **Real settings, t3:** the hand-back `<agent-message>` is 2,096 chars. A 904-char `<task-notification>` only pointed to it.
- The notification frame itself costs about 760 chars, so a return of about 600 chars would fit.

**Likely cause:** the offload agent ignores the new "about 600 characters" limit in `offload.md`. In both isolated turns it also spent lines explaining Bash denials.

### Check 6: the turn-6 brief mentions npm

The brief's Task line:

```
scan every package.json and every script (shell, Makefile, CI configs, Dockerfiles, docs) under <project> (skip .slate/)
and summarize the install commands they use (npm/yarn/pnpm/etc., ci vs install, flags, lockfiles, packageManager field).
Flag any that conflict with the project's pnpm convention.
```

**Likely cause:** turn 6 asks about install commands in general, so the brief lists package managers to look for. It is not the retired rule coming back; the brief applies the pnpm rule.

### Check 7: live memory mentions npm

`facts.md` had one match:

```
- [F9 t5] No npm, yarn, bun or npx usage found; neither package.json has a `packageManager` field (install scan, partial)
```

It was added at slate turn 5, which is script turn 6. At the end of the run it was the only live line matching npm. Earlier states weren't snapshotted.

**Likely cause:** a true negative finding from the turn-6 scan, which the curator recorded as a fact. It is not the stale rule.

### Check 1 (real settings): the init reply had two paragraphs

```
Slate is on for this session.

Separately, these servers need authorization before use: claude.ai Ramp, and the plugin servers asana, atlassian,
datadog, github, notion and pagerduty. I can't run the OAuth flow here. Use your claude.ai connector settings, or
`/mcp` in an interactive session.
```

**Likely cause:** the user's environment reports MCP servers that need authorization, and the model mentioned them despite the skill's "one line". slate's own line was correct.

### Check 13 (real settings): the subagent's hand-back was recorded as a user turn

- With the user's settings, the offload agent returned through the hand-back tool.
- UserPromptSubmit then fired with a prompt starting `<agent-message from="…">`.
- `hook.mjs` treats only prompts starting with `<task-notification>` as non-user. So this one became slate turn 3.
- `conversation/0003.md` holds the subagent's report as `<!-- slate:message -->`, and the curator was told it was "the user's message, verbatim".
- Here the curator labelled what it saved `(subagent report)`, so nothing was mis-attributed. But a subagent's words could become I items.

**Likely cause:** the `<agent-message>` prompt shape is missing from the prompt classifier.

## Real settings: does slate work alongside the user's setup?

- **Init:** worked. The folder was created and the rules were loaded. The startup context also carried another plugin's SessionStart block and learned rules.
- **Change lines:** the slate reminder was injected on turns 2 and 3, next to the other plugins' hooks.
- **Curator:** 3 `ok` lines, all on attempt 1. It ran the same real binary on `sonnet`.
- **Offload:** used in turn 3.
- **Report write: not blocked, and no prompt.**
  - The user's permission rules allow Bash. The agent ran `grep -rn "TODO(perf)" …` and wrote the report with a Bash heredoc (`mkdir -p … && cat > …/reports/todo-perf.md`), so no Write tool was used.
  - No tool call was denied, and `permission_denials` was empty on every turn.
- **For comparison, the isolated profile (`acceptEdits`)** denied Bash to the subagents twice:
  - t3: the first attempt to write the report through Bash. The agent then used Write, which succeeded.
  - t6: a `find` command. The scan was then incomplete, and the agent asked for Bash.
- **Cost:** about $0.46 for 3 turns, against $0.27 for the same 3 turns isolated. The extra context from the user's plugins is the likely reason.
- **Side effects outside the temp dirs.** The user's self-improvement plugin wrote usage notes for this session:
  - `~/.claude/self-improvement/notes/86553720-….json` and `…/state/86553720-….loaded.json`
  - No corrections and no new rules
  - Left in place

## Full run: answers

| Turn | Answer (chars) |
|---|---|
| 1 | Slate is on for this session. (29) |
| 2 | Got it: I'll use npm for all package-manager commands, and I've noted the staging host as stg-7.internal. (105) |
| 3 | 12 hits in 12 files, grouped, plus a note about a denied Bash write and the report path (961, 8 paragraphs or bullets) |
| 4 | Got it. From now on I'll give package-manager commands with pnpm instead of npm. (80) |
| 5 | `` `pnpm add lodash` `` (17) |
| 6 | All the install commands found use pnpm; the scan is incomplete because Bash was denied. Then bullets and the report path. (1,361) |

The new rule "answer in 2–3 lines and point to the report" was not followed in turns 3 and 6. This isn't asserted.

## Full run: final memory files

`instructions.md`
```
# Instructions
- [I2 t3] This project uses pnpm; give package-manager commands using pnpm
```

`assumptions.md`
```
# Assumptions
- [A1 t5] No pnpm-lock.yaml exists, so --frozen-lockfile installs would fail (not in file listing, which may be cut off at 200 lines; unverified)
```

`facts.md`
```
# Facts
- [F1 t1] The staging host is stg-7.internal (user)
- [F2 t2] 12 files mention "TODO(perf)", one hit each, all at line 33 (background agent search)
- [F3 t2] Data access TODOs (5): N+1 query in src/api/users.py, missing orders(created_at) index, nightly full-table scan in docs/architecture.md, unpaginated loading in src/api/orders.py, pool size hard-coded to 4 in src/db/pool.rs (marked `!!`) (agent report)
- [F4 t2] Other TODO(perf) groups: frontend 3 (memoization, table virtualization, lazy-load hero image); memory/algorithmic 3 (buffer copying, O(n^2) dedupe, non-streaming JSON ingest); caching 1 (DNS caching in config/resolver.yaml) (agent report)
- [F5 t2] Full TODO(perf) report is at <tmp>/slate-acc-z66xm2/.slate/297d5ee6-c7b3-4444-be30-59297a82e48b/reports/todo-perf.md (agent output)
- [F6 t5] Dockerfile runs `corepack enable && pnpm install --prod --frozen-lockfile` (install scan, partial)
- [F7 t5] scripts/setup.sh runs `pnpm install --frozen-lockfile` (install scan, partial)
- [F8 t5] packages/web `bootstrap` script runs plain `pnpm install` (install scan, partial)
- [F9 t5] No npm, yarn, bun or npx usage found; neither package.json has a `packageManager` field (install scan, partial)
- [F10 t5] packages/web `postinstall` calls scripts/patch-deps.js, which wasn't in the file listing (install scan)
- [F11 t5] Install scan was incomplete: Bash denied, so no grep; module_* files, docs/architecture.md, public/index.html not scanned (install scan)
- [F12 t5] Install commands report is at <tmp>/slate-acc-z66xm2/.slate/297d5ee6-c7b3-4444-be30-59297a82e48b/reports/install-commands.md (agent output)
```

`now.md`
```
Goal: scan every package.json and script in the repo and summarize the install commands they use.
Focus: partial summary delivered (turn 5); all found commands use pnpm; scan incomplete because Bash was denied.
Open: does pnpm-lock.yaml exist? Does scripts/patch-deps.js exist? Remaining files unscanned.
Last: turn 4 answered lodash install with `pnpm add lodash`.
Next: if user allows Bash, rerun scan with grep and confirm lockfile; give pnpm commands and use stg-7.internal for staging.
```

`superseded.md`
```
# Superseded
- [I1 t1 retired t3] For this project, always give package-manager commands using npm (reason: user switched project to pnpm)
```

The round-0 problem of a report's draft line becoming a fact did not recur. F5 and F12, which only give report locations, are still process notes recorded as facts.

## Full run: `curator.log`

```
2026-10-08T01:53:18.707Z t1 ok: attempt 1, changed instructions.md, facts.md, now.md
2026-10-08T01:53:36.761Z t2 ok: attempt 1, changed now.md
2026-10-08T01:54:31.390Z t2 ok: attempt 1, changed facts.md, now.md
2026-10-08T01:54:47.975Z t3 ok: attempt 1, changed instructions.md, now.md, superseded.md
2026-10-08T01:55:02.883Z t4 ok: attempt 1, changed now.md
2026-10-08T01:55:21.239Z t5 ok: attempt 1, changed now.md
2026-10-08T01:56:00.022Z t5 ok: attempt 1, changed assumptions.md, facts.md, now.md
```

- slate turns are one behind the script's turns, because `/slate:init` is not a turn.
- t2 and t5 each ran twice: once for the interim answer, then again when the background agent's result grew the turn file.

## Timings

| Turn | Full: `-p` wall | Full: curator wait | Real: `-p` wall | Real: curator wait |
|---|---|---|---|---|
| 1 init | 4.8 s | 0.8 s (none) | 6.1 s | 0.8 s (none) |
| 2 npm + staging | 3.2 s | 12.8 s | 5.3 s | 11.3 s |
| 3 search | 56.1 s | 16.5 s | 31.2 s | 13.5 s |
| 4 pnpm | 4.1 s | 12.8 s | | |
| 5 lodash | 3.5 s | 11.3 s | | |
| 6 install scan | 35.3 s | 21.8 s | | |

`total_cost_usd` grows across resumes. The full run cost about $0.43 and the real-settings pass about $0.46. Curator cost isn't captured.

## Curator binary

The script sampled `ps` for children of this session's `curate.mjs` and read each child's executable with `lsof`. All 10 curator runs (7 full, 3 real) showed the same thing:

| argv[0] | Executable (lsof txt) | Flags |
|---|---|---|
| `~/.local/bin/claude` | `~/.local/share/claude/versions/2.1.293` | `-p … --model sonnet` |

- argv[0] is an absolute path, so it came from `CLAUDE_CODE_EXECPATH`. The `PATH` fallback would show the bare name `claude`.
- The terminal-wrapper shim was not used.

## Interactive `/clear` and `/compact` check (round 0, not rerun)

A Python `pty` script ran at 120×40 in a fresh temp dir, with `--plugin-dir <repo>/plugins/slate --model sonnet --setting-sources project,local`. It ran before this round's wording changes to `rules.md`, `offload.md` and `curator-rules.md`.

| Step | Result | Evidence |
|---|---|---|
| `/slate:init` | PASS | The folder was created. The reply was "slate is on for this session." |
| `remember: deploy only on Fridays` | PASS | The curator settled in 11.4 s and wrote `- [I1 t1] deploy only on Fridays`. |
| `/clear` moves the folder | PASS | `3681dc40-…` → `ce99b436-…`. `session.json` has `from: "3681dc40-…"`, and the old folder is gone. |
| SessionStart(clear) reloads memory | PASS | The attachment has `# slate memory`, the rules, I1 and `# Now`. |
| First message after `/clear` gets the change line | PASS | The UserPromptSubmit attachment was `slate: offload heavy reads to slate:offload; reply briefly.` |
| The answer after `/clear` uses reloaded memory | PASS | "Deploy only on Fridays." |
| `/compact` reloads memory | PASS | The screen showed "Compacted" and PreCompact "completed successfully". The SessionStart attachment starts `# slate memory` / `Memory below wins where it differs from the summary.`, with I1. |

## Round 0, for reference

The first run had 5 turns and the original 8 checks, and all 8 passed. The review then found two gaps:
- Check 3 measured only `tool_result`, but the 2,274-char return arrived as a task-notification.
- The npm-brief check was vacuous, because no Agent call came after the switch.

This round adds checks 4 and 5 and turn 6.

## Cleanup

Removed after recording these results:

- `<tmp>/slate-acc-z66xm2` and `<tmp>/slate-acc-39j7qc` (round 1); `<tmp>/slate-acc-GxsSoL` and `<tmp>/slate-pty-0jrcenc0` (round 0)
- The matching `~/.claude/projects/-private-var-folders-…-T-slate-acc-*` and `…-slate-pty-*` folders, one per temp dir
- The matching `/private/tmp/claude-<uid>/-private-var-folders-…-T-slate-*` task-output dirs

Not removed, because they fall outside the cleanup ruling. All are harmless.

- Empty `~/.claude/session-env/<uuid>` dirs for the five session IDs. The real-settings one holds a hook script written by another plugin.
- The two self-improvement usage notes for the real-settings session (see above).
- Mentions of the temp paths in `~/.claude.json` (project entries).
