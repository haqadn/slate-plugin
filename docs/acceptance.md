# Live acceptance

Run on 2026-10-07 (local time) with Claude Code **2.1.293**, macOS. In this document, `<tmp>` stands for `$TMPDIR` and `~` for the home dir.

## Result

| Run | Checks | Result |
|---|---|---|
| **I2**: interactive, `/clear` during curation, final review | 7 / 7 | **PASS**. The curator was aborted and requeued; the block carried the "may not include turn 2" note; the drain re-curated turn 2 in the new folder. |
| **I1**: interactive, same script, lighter turn 2 | 3 / 7 | The abort path was not reached: the curator finished inside SessionStart's 20 s wait. So the abort, note, drain and change-line checks have no case (the block was already caught up, and the turn-3 change line was only the reminder). The other three passed. I2 covers all seven. |
| **R3**: real settings, turns 1–3, round 3 | 13 / 13 | **PASS**. A 869-char hand-back was denied once, and the 608-char retry went through. |
| **C**: isolated, 6 turns, round 2 | 19 / 19 | **PASS**. Run end to end on the round-2 script; checks 5, 9 and 19 recomputed from its data (see below). |
| **B**: isolated, 6 turns, round 2 | 19 / 19 | **PASS**, after the round-2 measurement fix to check 18. Checks 5, 9 and 19 recomputed. |
| R2: real settings, round 2 | 9 / 12 | Superseded by R3. It failed because the hand-back bypassed the return cap, which round 3 fixed. |

- **Isolated runs not rerun in round 3.** Round 3 changed the PreToolUse hook (`SubagentHandback` only), the `agent_id` guard, which unit tests cover, and three check definitions.
  - Recomputed from the recorded data: B and C's post-turn-4 Agent call was `slate:offload` (check 5); both wrote `CONTRIBUTING.md` (check 9); neither agent used the hand-back tool (check 19, so it has no cases).
- **The interactive `/clear` and `/compact` check** passed in round 0 and was rerun in the final review (I1, I2) with one added step: `/clear` while the curator runs. The `-p` runs (B, C, R3) were not rerun; the final review changed the curator rules (no `.slate/` path facts), the safety check, SessionStart and the drain, which unit tests cover.

## Setup

- **Script:** `node test/live/acceptance.mjs --live [--real-settings]`. `npm test` registers it as skipped.
- **Project:** a fresh temp dir, `<tmp>/slate-acc-*`, holding a fake repo of 200 files.
  - 12 files contain `TODO(perf)` in different comment styles. Near misses: `todo(perf)`, `TODO(perf, alice)`, `FIXME(perf)`, `TODO(security)`, `TODO perf:`.
  - There are install commands in `scripts/setup.sh`, `Dockerfile` and `packages/web/package.json`. All use pnpm; none uses npm.
- **Main session:** the real binary `~/.local/share/claude/versions/2.1.293`.
  - Every turn: `-p <prompt> --plugin-dir <repo>/plugins/slate --plugin-dir <probe> --model sonnet --output-format json`.
  - Turn 1 used `--session-id <uuid>`. Later turns used `--resume <uuid>`.
  - Env was limited to `HOME USER LOGNAME PATH SHELL TERM LANG TMPDIR`.
- **Probe:** a throwaway second plugin in `<tmp>/slate-probe-*`. It prints nothing, so it never affects a decision. It records:
  - every SubagentStop: field names, `agent_type`, `agent_id`, `stop_hook_active`, `session_id` and the length of `last_assistant_message`
  - every PreToolUse, with no matcher: `tool_name`, the `tool_input` keys, `agent_type`, `agent_id` and the `message` length
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

| # | Check | B | C | R3 |
|---|---|---|---|---|
| 1 | `/slate:init` created the folder and replied in one line (real settings: reported, never fails) | PASS | PASS | PASS (info) |
| 2 | Turn 3 used an Agent call with `slate:offload` | PASS | PASS | PASS |
| 3 | No main-thread `tool_result` over 2,000 chars | PASS (1,106) | PASS (1,106) | PASS (1,106) |
| 4 | No main-thread harness message over 2,000 chars | PASS (1,332 / 1,263) | PASS (1,371 / 1,385) | PASS (`agent-message` 1,823; `task-notification` 904) |
| 5 | At least one **`slate:offload`** Agent call after turn 4 | PASS (t6) | PASS (t6) | n/a |
| 6 | No Agent brief from turn 4 on contains an npm command `/\bnpm\s+(i\|install\|add\|ci\|run)\b/i` | PASS | PASS | n/a |
| 7 | No `/\bnpm\b/` in `instructions.md`, `assumptions.md` or `now.md` (facts exempt) | PASS | PASS | n/a |
| 8 | `superseded.md` matches `/\bnpm\b/` | PASS | PASS | n/a |
| 9 | `CONTRIBUTING.md` **exists**, uses pnpm and has no npm command | PASS | PASS | n/a |
| 10 | Turn-5 answer contains `pnpm` | PASS | PASS | n/a |
| 11 | `stg-7.internal` is in live memory | PASS | PASS | PASS |
| 12 | `curator.log` has no line matching `/\b(restored\|error)\b/i` | PASS | PASS | PASS |
| 13 | Every user turn got the slate change line | PASS | PASS | PASS |
| 14 | slate counted only user prompts as turns | PASS (5 for 5) | PASS (5 for 5) | PASS (2 for 2; `agent-message` and `task-notification` not counted) |
| 15 | `curator.log` has an `ok` line for every slate turn | PASS | PASS | PASS |
| 16 | Offload report written, and no subagent Write/Edit failed | PASS | PASS | PASS |
| 17 | SubagentStop input carries `agent_type`, `stop_hook_active`, `agent_id`, the main `session_id`, and `last_assistant_message` unless the agent handed back | PASS | PASS | PASS (handed back; no `last_assistant_message`) |
| 18 | Every `slate:offload` text return over 800 chars was sent back, at most once per agent | PASS | PASS | PASS (no text return; covered by 19) |
| 19 | Every `slate:offload` hand-back over 800 chars was denied exactly once | PASS (no hand-backs) | PASS (no hand-backs) | PASS (869 denied → 608 allowed) |

### Why the checks changed

**Round 2: checks 6, 7 and 9 replaced the old "no npm anywhere" checks.**
- Round 1 failed them, but not because the retired rule came back:
  - The brief named npm as something to search for.
  - The curator saved a true fact: "No npm … usage found".
- They now catch what matters:
  - an npm command in a brief
  - npm in a standing rule (I), an assumption (A) or `now.md`
  - npm in a file the agent wrote
- Turn 6 also changed, to a task that writes a file.

**Round 2: check 14 applies `hook.mjs`'s harness rule.**

**Round 2: checks 17 and 18 cover the SubagentStop cap.**

**Round 3: check 5 now requires the post-turn-4 call to be `slate:offload`, and check 9 requires `CONTRIBUTING.md` to exist.**

**Round 3: check 19 is new, and checks 17 and 18 changed for the hand-back path.**
- When an agent returns through the hand-back tool, its SubagentStop has no `last_assistant_message`.
- So 17 no longer requires that field for an agent that handed back.
- For the same reason, 18 treats a stop with no text as covered only if that agent made a successful hand-back, and check 19 verifies that hand-back's cap.
- A stop with no text and no hand-back still fails 18.

**Check 1 still fails the isolated profile when the reply is not one line.** Under real settings it only reports, because the user's MCP setup can add a paragraph that slate doesn't control.

## Return cap (best-effort)

An offload agent's return reaches the main thread through one of two channels. Each has its own hook. Any other channel relies on the ~600-character instruction in `offload.md`.

| Channel | Hook (matcher) | Measures | Over 800 chars |
|---|---|---|---|
| Final text answer | SubagentStop (`slate:offload`, matched on `agent_type`) | `last_assistant_message` | `decision: block` once, with the reason "Return is N chars. Rewrite it in ≤600 chars, ≤10 lines; details belong in the report." The next stop has `stop_hook_active: true` and passes. |
| Hand-back tool | PreToolUse (`SubagentHandback`) | `tool_input.message` | `permissionDecision: deny` once, with the reason "Hand-back is N chars. Call SubagentHandback again with ≤600 chars, ≤10 lines; details belong in the report." The marker `<dir>/handbacks/<agent_id>`, created with `wx`, lets the agent's next hand-back through. |

Both hooks act only when `agent_type` is `slate:offload` and the session has a slate folder. Both get past the `agent_id` guard. The input shapes are in `docs/verified.md` section 9.

**Text returns (runs B and C):**

| Run | Agent | First stop | Second stop | Harness message |
|---|---|---|---|---|
| B | t3 | 1,417 → sent back | 576 | 1,332 |
| B | t6 | 1,334 → sent back | 504 | 1,263 |
| C | t3 | 1,193 → sent back | 615 | 1,371 |
| C | t6 | 1,025 → sent back | 626 | 1,385 |

**Hand-back (run R3):**
- The probe saw 2 PreToolUse calls for `SubagentHandback` from `agent_type: slate:offload`, with `tool_input` keys `message`. They were 869 chars, denied, then 608 chars, allowed.
- The marker `handbacks/a1b26205ee073266b` was written.
- The `<agent-message>` in the main thread was 1,823 chars.

**Margin:** the hand-back frame adds about 1,200 fixed chars: the `[Subagent hand-back]` header plus a trailer about permissions. So a hand-back between about 785 and 800 chars would pass the hook but break check 4's 2,000 budget. Lowering the hand-back limit to about 700 would close this. Not done; it needs a ruling.

## Real settings: slate alongside the user's setup

- **Init, change lines, curator and offload** all worked next to the user's plugins in R3. The curator logged 3 `ok` lines.
- **Report write:** done with the Write tool, with no denial and no prompt.
- **Hand-back:** the offload agent returned through `SubagentHandback` in R2, R3 and the round-3 probe run.
  - `<agent-message>` was classified as a continuation, not a turn.
  - Under isolated settings, agents always returned a text answer.

## Main-thread reply lengths (not asserted; known limitation)

| Turn | B | C | R3 |
|---|---|---|---|
| 1 init | 98 | 29 | 29 |
| 2 npm + staging | 103 | 85 | 84 |
| 3 search | 797 | 705 | 757 |
| 4 pnpm | 112 | 69 | |
| 5 lodash | 15 | 17 | |
| 6 CONTRIBUTING | 521 | 612 | |

After an offload, the main thread wrote 500–800 chars. Short replies are a default, not a cap (`rules.md`), so this isn't a failure.

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
- **Report-location notes are still saved as facts:** F2 and F8 in run C, F4 in R3. The curator rule says facts are about the project. Paths to slate's own reports slip through. The final review added a curator rule against them (never store a fact that points to a report file or a `.slate/` path); the `-p` runs were not repeated to measure it.
- **R3's `now.md` noted that "the answer said a background search was still running".** The interim answer from the hand-back flow was curated as if it were part of the final answer. Harmless, but noisy.

## Timings

| Turn | B `-p` | B curator | C `-p` | C curator | R3 `-p` | R3 curator |
|---|---|---|---|---|---|---|
| 1 | 4.8 s | 0.8 s | 4.6 s | 0.8 s | 5.8 s | 0.8 s |
| 2 | 4.0 s | 13.5 s | 3.4 s | 21.8 s | 5.3 s | 12.8 s |
| 3 | 28.4 s | 16.5 s | 26.2 s | 24.8 s | 27.8 s | 16.5 s |
| 4 | 3.5 s | 13.5 s | 3.6 s | 12.8 s | | |
| 5 | 3.2 s | 9.0 s | 10.5 s | 8.3 s | | |
| 6 | 31.0 s | 20.3 s | 30.3 s | 17.3 s | | |

The "curator" columns are the wait after `-p` exits. Cumulative `total_cost_usd`: B $0.35, C $0.39, R3 $0.35. The round-3 probe run (one turn) cost $0.23. Curator cost isn't captured.

## Curator binary

The script sampled `ps` and `lsof` for children of this session's `curate.mjs`. All 17 curator runs (B 7, C 7, R3 3) showed the same thing:

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

## Interactive `/clear` during curation (final review)

**Setup.** A Python `pty` driver (not committed) ran at 120×40 in a fresh `<tmp>/slate-live-*` dir: `~/.local/share/claude/versions/2.1.293 --plugin-dir <repo>/plugins/slate --model sonnet --setting-sources project,local`. Env was limited to `HOME USER LOGNAME PATH SHELL LANG TMPDIR`, plus `TERM=xterm-256color`. The curator ran on its default (`sonnet`). Repo at `f7d7d49`.

**Steps.** `/slate:init`; `remember: deploy only on Fridays`, then wait for the curator; a long turn 2 (37 standing rules, 10 facts, a goal, one-line acknowledgement asked); `/clear` as soon as `curator.lock` appeared; wait for the drain; `Which branch do we deploy from, and on which day? One line.`; `/compact`; `/exit`. Evidence comes from the folder, `curator.log` and the hook attachments in the transcripts.

**I2** added 80 more rules to turn 2 (a 7,529-char message, 118 rules in all), so the curator would outlast the 20 s wait.

| Check | I2 | Evidence (I2) |
|---|---|---|
| `/clear` lands while the curator holds the lock | PASS | Turn 2 answered at 31.69 s; `curator.lock` seen at 31.71 s; `/clear` sent at 32.64 s. |
| The running curator is aborted and its turn requeued | PASS | `t2 aborted: requeued` at 03:10:09.628Z, 20 s after the `/clear` (the SessionStart wait), before the move. |
| The folder moved | PASS | `5731870f-…` → `092cf357-…`; `session.json` has `from: "5731870f-…"` and the same pid; the old folder is gone. |
| The injected block carries the note | PASS | SessionStart attachment at 03:10:09.679Z (1,776 chars) starts `# slate memory` / `slate: memory may not include turn 2 yet — read <tmp>/slate-live-iYwaHz/.slate/092cf357-…/conversation/0002.md before acting on recent instructions.` Its `# Instructions` holds only `- [I1 t1] deploy only on Fridays`: the block was built from the restored memory. |
| A drain ran in the new folder | PASS | `t2 ok: attempt 1, changed instructions.md, facts.md, now.md` at 03:10:39.543Z; `curated.json` reached turn 2. 118 I items and 10 F items. |
| The next message's change line shows the curated delta | PASS | Turn-3 UserPromptSubmit attachment: `slate: +I2 always use pnpm for package commands · +I3 deploy only from the release/2.4 branch · +I4 … · +I5 … · +I6 indent .py files with 4 spaces · +122 more (see …/instructions.md, facts.md)`. The answer: "Deploy from `release/2.4`, on Fridays only." |
| `/compact` reloads memory | PASS | SessionStart(compact) attachment, 9,850 chars, starts `# slate memory` / `Memory below wins where it differs from the summary.`; no lag note (caught up). |

**I1** (turn 2 with 37 rules): `/clear` was sent 0.9 s after `curator.lock` appeared, but this curator took about 17 s. SessionStart waited it out: `t2 ok` at 03:08:07.262Z, the SessionStart attachment at 03:08:07.292Z. No abort, so no note, which is correct for a caught-up folder; the block held I1–I38 and F1–F10. Every other step passed: the move (`ab38a298-…` → `dbaf6bb9-…`), the turn-3 answer ("Deploy from `release/2.4`, on Fridays."), and the compact reload.

**After both runs:** no `curate.mjs` or curator `claude -p` process was left running.

**Final curator.log (I2):**

```
2026-10-08T03:09:44.603Z t1 ok: attempt 1, changed instructions.md
2026-10-08T03:10:09.628Z t2 aborted: requeued
2026-10-08T03:10:39.543Z t2 ok: attempt 1, changed instructions.md, facts.md, now.md
2026-10-08T03:10:53.982Z t3 ok: attempt 1, no change
```

## Offload index and turn queue (2026-10-13)

`node test/live/acceptance.mjs --live`, then `--live --real-settings`, on branch `feat/offload-index`.

| Run | Checks | Cost | Offload entries | `queue/` after the run |
|---|---|---|---|---|
| Isolated, 6 turns | 21 PASS | $1.09 | 2 agents, 1 entry each; both transcripts exist and hold tool calls | `0005.md` (newest turn 5) |
| Real settings, 3 turns | 15 PASS | $0.65 | 1 agent, 1 entry; transcript exists, holds tool calls | `0002.md` (newest turn 2) |

- The real-settings agent returned through the hand-back. Its 822-char message was denied, and the 481-char resend was let through and recorded.
- Every SubagentStop carried `agent_transcript_path`: 4 stops in the isolated run, 1 in the real-settings run.
- **Probe:** a follow-up `-p` turn in the isolated session had `slate:offload` dig into the first entry's transcript ($0.57).
  - Reading the whole transcript failed: 50,134 tokens, over Read's 25,000 limit. Read with offset and limit worked.
  - Bash `grep` was denied under `acceptEdits`, and the agent didn't try the Grep tool.
  - It answered correctly and wrote its report.

## Earlier rounds

**Round 0:** 5 turns and 8 checks, all passed. The review then found two gaps:
- The return channel was unchecked.
- The npm-brief check was vacuous.

**Round 1** added turn 6, a real-settings pass and stricter checks. It found:
- returns over the cap
- harness messages counted as user turns
- npm checks that fired on search terms and true facts

**Round 2** fixed or redefined each of these: the harness classifier, the SubagentStop cap, and the new npm checks. Its real-settings pass (R2) then found that the hand-back path bypassed the cap.

**Round 3** added the PreToolUse cap on `SubagentHandback`, check 19, and tighter checks 5 and 9. It reran only the real-settings pass, as R3.

**Final review** fixed folder theft by `/clear` and `/branch` after an in-process `/resume`, the silent memory gap after a `/clear` during curation, and a trailing-whitespace freeze, plus minor items. It reran only the interactive check, as I1 and I2.

## Cleanup

Removed after recording these results:

- **Final review:**
  - `<tmp>/slate-live-SifItX` (I1), `<tmp>/slate-live-iYwaHz` (I2) and `<tmp>/slate-driver-9PBA1O` (the driver and its logs)
  - `~/.claude/projects/-private-var-folders-…-T-slate-live-SifItX` and `…-slate-live-iYwaHz`
  - `/private/tmp/claude-<uid>/-private-var-folders-…-T-slate-live-SifItX` and `…-slate-live-iYwaHz`

- **Round 3:**
  - `<tmp>/slate-acc-ktCqBt` (R3) and `<tmp>/slate-r3probe-CnnRzZ` (the probe run)
  - `<tmp>/slate-probe-wuPRlR`, `<tmp>/slate-probe-h66c82`
- **Round 2:**
  - `<tmp>/slate-acc-Lq2nQv`, `<tmp>/slate-acc-A63LPF`, `<tmp>/slate-acc-Z918s3`
  - `<tmp>/slate-probe-Os8bfC`, `<tmp>/slate-probe-Md5Q05`, `<tmp>/slate-probe-oGoB9Y`
- **Earlier rounds:** `<tmp>/slate-acc-GxsSoL`, `<tmp>/slate-pty-0jrcenc0`, `<tmp>/slate-acc-z66xm2`, `<tmp>/slate-acc-39j7qc`
- The matching `~/.claude/projects/-private-var-folders-…-T-slate-acc-*`, `…-slate-r3probe-*` and `…-slate-pty-*` folders, one per temp project dir
- The matching `/private/tmp/claude-<uid>/-private-var-folders-…-T-slate-*` task-output dirs

**Offload index run (2026-10-13): left in place.** A safety hook in this setup blocks recursive deletes. Remove by hand:

- `<tmp>/slate-acc-s48f4J`, `<tmp>/slate-acc-oFCWny`, `<tmp>/slate-probe-Aai8Ot`, `<tmp>/slate-probe-YTY6Qx`
- `~/.claude/projects/-private-var-folders-…-T-slate-acc-s48f4J` and `…-slate-acc-oFCWny`
- `/private/tmp/claude-<uid>/-private-var-folders-…-T-slate-acc-s48f4J` and `…-slate-acc-oFCWny`

Not removed, because they fall outside the cleanup ruling. All are harmless.

- Empty `~/.claude/session-env/<uuid>` dirs for each session. The real-settings ones also hold a `sessionstart-hook-2.sh` written by another plugin's SessionStart hook.
- **Files the user's self-improvement plugin wrote for the real-settings sessions:**
  - round 3: `~/.claude/self-improvement/notes/{edbb984a,28a8ba19}-….json` and `…/state/{edbb984a,28a8ba19}-….loaded.json`
  - round 2: `~/.claude/self-improvement/notes/20fe55c4-….json`, `…/state/20fe55c4-….json` and `…/state/20fe55c4-….loaded.json`
  - round 1: the matching `86553720-…` notes and state files
  - The shared `state/consolidated.json` lists these sessions.
  - They hold usage notes only: no corrections, and no learned rules (`rules.json` and `pending/*.json` don't mention them).
  - Its `logs/worker-error.log` also gained a "no JSON found in model output" entry during round 3. It can't be attributed to a session.
- Mentions of the temp paths in `~/.claude.json` (project entries).
