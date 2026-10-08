# Live acceptance

Run on 2026-10-07 (local time) with Claude Code **2.1.293**, macOS. In this document, `<tmp>` stands for `$TMPDIR` and `~` for the home dir.

## Result

| Run | Checks | Result |
|---|---|---|
| **C**: isolated, 6 turns, the final script | 18 / 18 | **PASS** |
| **B**: isolated, 6 turns, this round's first run | 18 / 18 | **PASS**, after one measurement bug in the script was fixed. See [Script fixes after run B](#script-fixes-after-run-b). |
| **R**: real settings, turns 1–3 | 9 / 12 | **FAIL**: the subagent hand-back bypasses the return cap. See [Finding](#finding-the-hand-back-path-bypasses-the-return-cap). |

The interactive `/clear` and `/compact` check passed in round 0. This round changed nothing on those paths, so it was not rerun.

## Setup

- **Script:** `node test/live/acceptance.mjs --live [--real-settings]`. `npm test` registers it as skipped.
- **Project:** a fresh temp dir, `<tmp>/slate-acc-*`, holding a fake repo of 200 files.
  - 12 files contain `TODO(perf)` in different comment styles. Near misses: `todo(perf)`, `TODO(perf, alice)`, `FIXME(perf)`, `TODO(security)`, `TODO perf:`.
  - There are install commands in `scripts/setup.sh`, `Dockerfile` and `packages/web/package.json`. All use pnpm; none uses npm.
- **Main session:** the real binary `~/.local/share/claude/versions/2.1.293`.
  - Every turn: `-p <prompt> --plugin-dir <repo>/plugins/slate --plugin-dir <probe> --model sonnet --output-format json`.
  - Turn 1 used `--session-id <uuid>`. Later turns used `--resume <uuid>`.
  - Env was limited to `HOME USER LOGNAME PATH SHELL TERM LANG TMPDIR`.
- **Probe:** a throwaway second plugin in `<tmp>/slate-probe-*`. Its SubagentStop hook records the input's field names, `agent_type`, `agent_id`, `stop_hook_active`, `session_id` and the length of `last_assistant_message`. It produces no output.
- **Profiles:**

| Profile | Extra flags | What loads |
|---|---|---|
| Isolated (6 turns) | `--setting-sources project,local --permission-mode acceptEdits` | Only slate and the probe |
| Real settings (turns 1–3) | none | Also the user's plugins, hooks, CLAUDE.md and permission rules |

- **Between turns:** the script polled every 0.75s, for at most 180s. It waited until `curator.lock` was gone and `curated.json` matched both `session.json`'s turn and that turn file's size, on two polls in a row.
- **Curator:** its default model (`sonnet`).

**Turns:**
1. `/slate:init`
2. `For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.`
3. `Find every file that mentions "TODO(perf)" and summarize the patterns.`
4. `Change of plan: this project uses pnpm now.`
5. `What command installs lodash? Reply with only the command.`
6. `Research this repo, then draft a short "Install" section for CONTRIBUTING.md. Write it to CONTRIBUTING.md.`

## Checks

- The main transcript is `~/.claude/projects/<slug>/<uuid>.jsonl`, with sidechain entries excluded.
- A "harness message" is a user message starting with one of `hook.mjs`'s `HARNESS_PREFIXES`: `<task-notification`, `<agent-message`, `<cross-session-message`, `<teammate-message` or `[SYSTEM NOTIFICATION`. The transcript may put one intro line before the tag.

| # | Check | B | C | R |
|---|---|---|---|---|
| 1 | `/slate:init` created the folder and replied in one line (real settings: reported, never fails) | PASS | PASS | PASS (info) |
| 2 | Turn 3 used an Agent call with `slate:offload` | PASS | PASS | PASS |
| 3 | No main-thread `tool_result` over 2,000 chars | PASS (1,106) | PASS (1,106) | PASS (1,106) |
| 4 | No main-thread harness message over 2,000 chars | PASS (1,332 / 1,263) | PASS (1,371 / 1,385) | **FAIL** (`agent-message` 2,119) |
| 5 | At least one Agent call after turn 4 | PASS (t6) | PASS (t6) | n/a |
| 6 | No Agent brief from turn 4 on contains an npm command `/\bnpm\s+(i\|install\|add\|ci\|run)\b/i` | PASS | PASS | n/a |
| 7 | No `/\bnpm\b/` in `instructions.md`, `assumptions.md` or `now.md` (facts exempt) | PASS | PASS | n/a |
| 8 | `superseded.md` matches `/\bnpm\b/` | PASS | PASS | n/a |
| 9 | `CONTRIBUTING.md`, if written, uses pnpm and has no npm command | PASS (written) | PASS (written) | n/a |
| 10 | Turn-5 answer contains `pnpm` | PASS | PASS | n/a |
| 11 | `stg-7.internal` is in live memory | PASS | PASS | PASS |
| 12 | `curator.log` has no line matching `/\b(restored\|error)\b/i` | PASS | PASS | PASS |
| 13 | Every user turn got the slate change line | PASS | PASS | PASS |
| 14 | slate counted only user prompts as turns | PASS (5 for 5) | PASS (5 for 5) | PASS (2 for 2; the `agent-message` was not counted) |
| 15 | `curator.log` has an `ok` line for every slate turn | PASS | PASS | PASS |
| 16 | Offload report written, and no subagent Write/Edit failed | PASS | PASS | PASS |
| 17 | SubagentStop input carries `agent_type`, `last_assistant_message`, `stop_hook_active`, `agent_id` and the main `session_id` | PASS | PASS | **FAIL** (no `last_assistant_message`) |
| 18 | Every `slate:offload` return over 800 chars was sent back, at most once per agent | PASS | PASS | **FAIL** (the return was invisible to the hook) |

### Why the checks changed this round

**Checks 6, 7 and 9 replace the old "no npm anywhere" checks.**
- Round 1 failed them, but not because the retired rule came back:
  - The brief named npm as something to search for ("npm/yarn/pnpm/etc.").
  - The curator saved a true fact: "No npm, yarn, bun or npx usage found".
- They now catch what matters:
  - an npm command in a brief
  - npm in a standing rule (I), an assumption (A) or `now.md`
  - npm in a file the agent wrote
- Turn 6 also changed, from an install-command scan to a task that writes a file, so check 9 has something to judge.

**Check 14 now applies `hook.mjs`'s harness rule.** Round 1 found a hand-back recorded as a user turn.

**Checks 17 and 18 cover the new SubagentStop cap.**

**Check 1 still fails the isolated profile when the reply is not one line.** Under real settings it only reports, because the user's MCP setup can add a paragraph that slate doesn't control.

## Mechanical return cap (SubagentStop)

`hooks.json` has `SubagentStop` with matcher `slate:offload`. The binary matches that event's matcher on `agent_type`.

`hook.mjs` blocks once when all of these hold:
- `agent_type` is `slate:offload`
- the session has a folder
- `stop_hook_active` is not `true`
- `last_assistant_message` is over 800 characters

The block reason is `Return is <N> chars. Rewrite it in ≤600 chars, ≤10 lines; details belong in the report.`

**Input shape, confirmed by the probe in runs B and C:**

```
agent_id, agent_transcript_path, agent_type, background_tasks, cwd, effort, hook_event_name,
last_assistant_message, permission_mode, prompt_id, session_crons, session_id, stop_hook_active, transcript_path
```

- `session_id` is the main session's ID, so the folder lookup works.
- `agent_id` is always present, so `hook.mjs` lets SubagentStop past the "fired inside a subagent" guard.

**What happened:**

| Run | Agent | First stop | Second stop (`stop_hook_active: true`) | Harness message in main thread |
|---|---|---|---|---|
| B | t3 | 1,417 chars → sent back | 576 | 1,332 |
| B | t6 | 1,334 chars → sent back | 504 | 1,263 |
| C | t3 | 1,193 chars → sent back | 615 | 1,371 |
| C | t6 | 1,025 chars → sent back | 626 | 1,385 |

- Each send-back is persisted in the agent's transcript twice: a `Stop hook feedback:` meta message and one `hook_blocking_error` attachment.
- No agent was sent back twice.
- The rewritten returns were 504–626 chars. That is slightly over the 600 asked for but under the 800 limit, so they passed.

## Finding: the hand-back path bypasses the return cap

Under real settings, the offload agent ended by calling the hand-back tool instead of writing a final text answer.

- Its SubagentStop input had no `last_assistant_message`; the probe recorded the keys without it, and the length as `null`. So the cap could not measure it, and nothing was sent back.
- The report reached the main thread as an `<agent-message>` of 2,119 chars, failing check 4.
- Checks 17 and 18 fail for the same reason.

**Likely fix, not done this round (needs a ruling):** cap the hand-back itself. A `PreToolUse` hook matched on the hand-back tool would deny a `message` over 800 chars with the same reason. Or SubagentStop could read the hand-back text from `agent_transcript_path` when `last_assistant_message` is absent.

The harness rule worked on this path:
- The `<agent-message>` was classified as a notification and appended to slate turn 2 as a continuation.
- `curator.log` shows t2 curated twice, which is expected.
- `session.json` has turn 2 for 2 user prompts.

## Script fixes after run B

1. **Check 18 counted text matches instead of block events.**
   - The reason text appears 3 times per block: in the feedback message and twice in the attachment. So run B's console printed FAIL with every return correctly blocked.
   - The committed `offloadBlocks()` now counts `hook_blocking_error` attachments. It also treats an agent stopping again with `stop_hook_active: true` as proof of a send-back.
   - Recomputed on run B's transcripts and probe log: PASS, 1 block per agent. Run C ran the fixed script end to end.
2. **Check 18 now counts a stop with no `last_assistant_message` as over the limit and not sent back.**
   - This is stricter. Run R's console showed it as a vacuous PASS ("null chars"). Recomputed on run R's data, it fails.

## Real settings: slate alongside the user's setup

- **Init, change lines, curator and offload** all worked next to the user's plugins. The curator logged 3 `ok` lines.
- **Init reply:** one line this time ("Slate is on for this session."). In round 1 the same setup added an MCP-authorization paragraph.
- **Report write:** done with the Write tool, as `offload.md` now asks. It was not blocked, there was no prompt, and no tool call was denied.
- **Turn 3 took 73 s.** The hand-back flow and the user's hooks are the likely reason.

## Main-thread reply lengths (not asserted; known limitation)

| Turn | B | C | R |
|---|---|---|---|
| 1 init | 98 | 29 | 29 |
| 2 npm + staging | 103 | 85 | 73 |
| 3 search | 797 | 705 | 658 |
| 4 pnpm | 112 | 69 | |
| 5 lodash | 15 | 17 | |
| 6 CONTRIBUTING | 521 | 612 | |

After an offload, the main thread still writes 500–800 chars, not the 2–3 lines `rules.md` asks for.

## Run C: answers

- **Turn 5:** `` `pnpm add lodash` ``
- **Turn 6:** `CONTRIBUTING.md` was written by the offload agent with the Write tool:

````
## Install

This project uses pnpm.

Requirements:
- Node.js 24 (matches the `node:24-slim` image in the Dockerfile)
- pnpm, via Corepack (bundled with Node)

Setup:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Or run `pnpm run setup`, which runs `scripts/setup.sh` and does the same thing.

Common commands:
- `pnpm test` runs the tests (`node --test`).
- `pnpm --filter @acme/web build` builds the web package (`vite build`).

Note: `packages/web` runs `scripts/patch-deps.js` after install, so install from the repo root.
````

## Run C: final memory files

`instructions.md`
```
# Instructions
- [I2 t3] For this project, use pnpm
```

`assumptions.md`
```
# Assumptions
- [A1 t2] TODO(perf) appears in 11 files, always at line 33 (from the background agent's report; theme counts sum to 13, so unverified)
```

`facts.md`
```
# Facts
- [F1 t1] The staging host is stg-7.internal (user)
- [F2 t2] The TODO(perf) search report with the full file list is at .slate/420df930-83fc-450e-a53e-b5a3ffe9dfd3/reports/todo-perf.md (assistant answer)
- [F3 t2] src/db/pool.rs is the only TODO(perf) file marked "!!" (search report)
- [F4 t5] CONTRIBUTING.md at the repo root has an Install section using pnpm and Node 24, with --frozen-lockfile; commands not run (assistant answer)
- [F5 t5] Node 24 comes only from the Dockerfile (agent report)
- [F6 t5] There is no pnpm-lock.yaml, so --frozen-lockfile will fail (agent report)
- [F7 t5] scripts/patch-deps.js does not exist, so the postinstall step in packages/web will likely fail (agent report)
- [F8 t5] Install research notes are at .slate/420df930-83fc-450e-a53e-b5a3ffe9dfd3/reports/install-section.md (assistant answer)
```

`now.md`
```
Goal: draft a short "Install" section in CONTRIBUTING.md (using pnpm).
Focus: section written; known problems: no pnpm-lock.yaml, missing scripts/patch-deps.js, Node 24 only from Dockerfile.
Open: drop --frozen-lockfile from the section? Fix or document the missing patch-deps.js postinstall? Confirm Node version?
Next: wait for the user's decision on removing --frozen-lockfile, then edit CONTRIBUTING.md.
```

`superseded.md`
```
# Superseded
- [I1 t1 retired t3] For this project, always give package-manager commands using npm (reason: user switched to pnpm)
```

## Run C: `curator.log`

```
2026-10-08T02:14:58.370Z t1 ok: attempt 1, changed instructions.md, facts.md, now.md
2026-10-08T02:15:15.981Z t2 ok: attempt 1, changed now.md
2026-10-08T02:15:49.368Z t2 ok: attempt 1, changed assumptions.md, facts.md, now.md
2026-10-08T02:16:05.854Z t3 ok: attempt 1, changed instructions.md, superseded.md
2026-10-08T02:16:25.165Z t4 ok: attempt 1, no change
2026-10-08T02:16:46.266Z t5 ok: attempt 1, changed now.md
2026-10-08T02:17:12.227Z t5 ok: attempt 1, changed facts.md, now.md
```

slate turns are one behind the script's turns. t2 and t5 each ran twice: once for the interim answer, then for the background agent's result.

## Observations (not asserted)

- **The search count is unreliable.**
  - In run C the offload agent reported "11 matches, 11 files", but its own table lists all 12.
  - The main thread flagged the mismatch, and the curator stored the count as an unverified A item, not a fact.
  - Model accuracy; the slate flow handled it well.
- **Report-location notes are still saved as facts** (F2, F8). The curator rule says facts are about the project. Paths to slate's own reports slip through.

## Timings

| Turn | B `-p` | B curator | C `-p` | C curator | R `-p` | R curator |
|---|---|---|---|---|---|---|
| 1 | 4.8 s | 0.8 s | 4.6 s | 0.8 s | 5.8 s | 0.8 s |
| 2 | 4.0 s | 13.5 s | 3.4 s | 21.8 s | 5.6 s | 13.5 s |
| 3 | 28.4 s | 16.5 s | 26.2 s | 24.8 s | 73.3 s | 15.0 s |
| 4 | 3.5 s | 13.5 s | 3.6 s | 12.8 s | | |
| 5 | 3.2 s | 9.0 s | 10.5 s | 8.3 s | | |
| 6 | 31.0 s | 20.3 s | 30.3 s | 17.3 s | | |

The "curator" columns are the wait after `-p` exits. Cumulative `total_cost_usd`: B $0.35, C $0.39, R $0.45. Curator cost isn't captured.

## Curator binary

The script sampled `ps` and `lsof` for children of this session's `curate.mjs`. All 17 curator runs (B 7, C 7, R 3) showed the same thing:

| argv[0] | Executable | Flags |
|---|---|---|
| `~/.local/bin/claude` | `~/.local/share/claude/versions/2.1.293` | `-p … --model sonnet` |

argv[0] is an absolute path, so it came from `CLAUDE_CODE_EXECPATH`. The terminal-wrapper shim was not used.

## Interactive `/clear` and `/compact` check (round 0)

A Python `pty` script ran at 120×40 in a fresh temp dir with `--plugin-dir <repo>/plugins/slate --model sonnet --setting-sources project,local`.

| Step | Result | Evidence |
|---|---|---|
| `/slate:init` | PASS | The folder was created. The reply was "slate is on for this session." |
| `remember: deploy only on Fridays` | PASS | The curator settled in 11.4 s and wrote `- [I1 t1] deploy only on Fridays`. |
| `/clear` moves the folder | PASS | `3681dc40-…` → `ce99b436-…`. `session.json` has `from: "3681dc40-…"`, and the old folder is gone. |
| SessionStart(clear) reloads memory | PASS | The attachment has `# slate memory`, the rules, I1 and `# Now`. |
| First message after `/clear` gets the change line | PASS | The UserPromptSubmit attachment was `slate: offload heavy reads to slate:offload; reply briefly.` |
| The answer after `/clear` uses reloaded memory | PASS | "Deploy only on Fridays." |
| `/compact` reloads memory | PASS | The screen showed "Compacted" and PreCompact "completed successfully". The SessionStart attachment starts `# slate memory` / `Memory below wins where it differs from the summary.`, with I1. |

## Earlier rounds

**Round 0:** 5 turns and 8 checks, all passed. The review then found two gaps:
- The return channel was unchecked.
- The npm-brief check was vacuous.

**Round 1** added turn 6, a real-settings pass and stricter checks. It found:
- returns over the cap
- harness messages counted as user turns
- npm checks that fired on search terms and true facts

Round 2 fixed or redefined each of these.

## Cleanup

Removed after recording these results:

- **Round 2:**
  - `<tmp>/slate-acc-Lq2nQv`, `<tmp>/slate-acc-A63LPF`, `<tmp>/slate-acc-Z918s3`
  - `<tmp>/slate-probe-Os8bfC`, `<tmp>/slate-probe-Md5Q05`, `<tmp>/slate-probe-oGoB9Y`
- **Earlier rounds:** `<tmp>/slate-acc-GxsSoL`, `<tmp>/slate-pty-0jrcenc0`, `<tmp>/slate-acc-z66xm2`, `<tmp>/slate-acc-39j7qc`
- The matching `~/.claude/projects/-private-var-folders-…-T-slate-acc-*` and `…-slate-pty-*` folders, one per temp project dir
- The matching `/private/tmp/claude-<uid>/-private-var-folders-…-T-slate-*` task-output dirs

Not removed, because they fall outside the cleanup ruling. All are harmless.

- Empty `~/.claude/session-env/<uuid>` dirs for each session. The real-settings ones also hold a `sessionstart-hook-2.sh` written by another plugin's SessionStart hook.
- **Files the user's self-improvement plugin wrote for the real-settings sessions:**
  - round 2: `~/.claude/self-improvement/notes/20fe55c4-….json`, `…/state/20fe55c4-….json` and `…/state/20fe55c4-….loaded.json`
  - round 1: the matching `86553720-…` notes and state files
  - The shared `state/consolidated.json` lists both sessions.
  - They hold usage notes only: no corrections, and no learned rules (`rules.json` and `pending/*.json` don't mention them).
- Mentions of the temp paths in `~/.claude.json` (project entries).
