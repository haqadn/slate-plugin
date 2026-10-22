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

## Shared slates (2026-10-22)

`node test/live/acceptance.mjs --live --out <results.json>` on branch `feat/shared-slates`, with Claude Code **2.1.308**.

**Result: PASS, 28 / 28 (run 3, rechecked).** One Bash call on the slate was denied; per the ruling it is reported as a note, not a failure.

**Known limitation:** Claude Code 2.1.308 has no Grep or Glob tool, so an agent that greps the slate with Bash may get a permission prompt. Adding `~/slate` to `permissions.additionalDirectories` avoids it (Task 6 puts this in the README).

| Run | Checks | Cost A / B | Changed after the run |
|---|---|---|---|
| 1 | 23 / 27 | $0.60 / $0.42 | **Product:** offload.md and rules.md now keep Bash off slate paths and send readers to `offloads.md` for reports. **Script:** check 1 is now timed from the transcript, and the substitution check reads only the skill message. |
| 2 | 23 / 27 | $0.70 / $0.51 | **Product:** offload.md drops the "check the report path first" step, and the link reply is one line that doesn't restate the rules. **Script:** B became one long-lived session, and check 3 was split into 3a–3c. |
| 3 | 27 / 28 | $0.71 / $0.22 | 3c failed on B's one Bash `grep` of `reports/`. Ruling: 3c fails only on a Read, Write or Edit denial on a slate path; Bash denials there are reported as a note. |
| 3, rechecked | **28 / 28** | none | `--recheck` re-evaluated 3c and the note from run 3's saved outputs, with no model calls. Every other check carries over as recorded. |

Costs are the main sessions only; curator runs aren't captured.

### Setup

- **SLATE_HOME** is a fresh `<tmp>/slate-home-*`. The script pre-creates the slate `accept` with `createSlate`.
- **Both sessions** run with `--plugin-dir <repo>/plugins/slate --plugin-dir <probe> --model sonnet --setting-sources project,local --output-format stream-json --verbose`.
  - There's no `--permission-mode`, so both run in the default mode.
  - Env is limited to `HOME USER LOGNAME PATH SHELL TERM LANG TMPDIR`, plus `SLATE_HOME`.
- **Guard:** each turn's stream-json `init` must list exactly one `slate` plugin, at this checkout's path, and `permissionMode: default`; otherwise the run stops. All 9 turns passed, so the installed plugin (old code, in the main checkout) never loaded.
- **A** works in `<tmp>/slate-acc-*`, the 200-file fake repo. Each turn is its own `-p` run (`--resume` after the first), and the script waits for A's curator between turns.
- **B** works in `<tmp>/slate-acc-b-*`, which holds only a README.
  - `/slate:link accept` runs in its own `-p`. Turns 2–4 then run in one long-lived `-p --input-format stream-json --resume` session.
  - Like an interactive peer, B gets no SessionStart between turns, so each change line shows what A changed since B's last prompt.
  - Run 2 resumed B on every turn. SessionStart then re-injected memory that already had A's pnpm item, so the change line was rightly empty.
  - A streamed turn ends once its result is in, every agent it launched has stopped (per the probe), a later result has followed any such stop, and stdout has been quiet for 3 s.

| # | A | B, and when it starts |
|---|---|---|
| 1 | `/slate:link accept` | `/slate:link accept`, at the same time |
| 2 | `For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.` | `For this topic, release branches are always named release/<version>; the current one is release/2.4. Reply in one line.`, when A's turn 2 ends |
| 3 | `Find every file that mentions "TODO(perf)" and summarize the patterns.` | `Another session on this slate wrote a TODO(perf) report. Which file does it mark "!!"? Reply in one line.`, when A's turn 3 ends |
| 4 | `Change of plan: this project uses pnpm now.` | `Which package manager does this topic use? Reply in one line.`, once A's turn 4 is curated |
| 5 | `What command installs lodash? Reply with only the command.` | |

A's old turn 6, which wrote `CONTRIBUTING.md`, is gone because it wrote into the project and check 4 forbids that. Old checks 5 and 9 went with it.

### Checks (run 3, rechecked)

| # | Check | Result | Evidence |
|---|---|---|---|
| G | Every turn: one slate plugin (this checkout's), default mode | PASS | 9 of 9 turns |
| L1 | `/slate:link accept` linked each session by its own ID and replied in one line | PASS | `.sessions/` holds exactly A and B. Both replied "Linked to slate \`accept\`." |
| L2 | The skill text has `${CLAUDE_SESSION_ID}`, `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` substituted, and its Bash link call ran | PASS | The skill message reads ``it is `accept` `` and `node "<repo>/plugins/slate/scripts/slate.mjs" link "<own id>" '<name>'`. The call returned `linked`, with no permission denial. |
| 1 | After A's pnpm turn is curated, B's next UserPromptSubmit output has `+I` with pnpm | PASS | A logged `t3 ok … replace I1 I3` at 19:47:20.871. B's turn 4 at 19:47:21.991 got `slate: +I3 For this project, always give package-manager commands using pnpm. · retired I1`. B answered "pnpm …". |
| 2a | A's and B's curators overlapped | PASS | 3 pairs overlapped, the longest by 3.9 s: A t3 ran 19:47:11.2–20.5 and B t2 ran 19:47:13.3–17.2. Starts come from `ps`; ends are the curator.log lines. |
| 2b | Every item either session added is present with its session tag, IDs are unique, and every ID comes from a logged add | PASS | A added I1, F1 and I3; B added I2 and F2. That's 5 IDs, with no duplicate. |
| 3a | A's offload wrote `reports/todo-perf-scan.md`, and the Write wasn't denied | PASS | |
| 3b | B read A's report with Read, and the read wasn't denied | PASS | B's agent read `offloads.md`, then `todo-perf-scan.md`. |
| 3c | No Read, Write or Edit call on a slate path was denied, in either session | PASS | No denials in A or B, and none outside the slate either. |
| note | Other calls on slate paths denied (known limitation, not a failure) | 1 | B's agent ran `grep -rl "TODO(perf)" <slate>/reports/`, which got "grep in … was blocked. For security, Claude Code may only search … the allowed working directories". It then read `offloads.md` and the report. |
| 4 | Nothing was written under either cwd, nor under `~/slate` | PASS | A's 217 entries and B's folder are unchanged. `~/slate` was absent before and after. |
| J | Curator `--json-schema` change lists came back and were applied | PASS | All 8 curator runs used `-p … --json-schema`. A logged 5 `ok` lines with 3 adds, and B logged 3 `ok` lines with 2 adds. No retry, no "no change list". |

The earlier checks, adapted to the new paths, all pass:

| Check | Run 3 |
|---|---|
| A's turn 3 used `slate:offload` | PASS |
| No A main-thread `tool_result` over 2,000 chars | PASS (1,754) |
| No harness message over 2,000 chars | PASS (A's task-notification: 1,258) |
| No Agent brief from turn 4 on has an npm command | PASS (none) |
| No npm in `instructions.md`, `assumptions.md` or either `now.md` | PASS |
| `superseded.md` mentions npm | PASS |
| A's turn-5 answer contains pnpm | PASS (`pnpm add lodash`) |
| `stg-7.internal` is in live memory | PASS (`facts.md`) |
| `curator.log` has no `partial` or `error` line, in either session (was `restored\|error`) | PASS |
| Every user turn got the change line | PASS (A: 2–5; B: 2–4) |
| Only user prompts counted as turns | PASS (A 4, B 3; A's task-notification not counted) |
| An `ok` line for every slate turn | PASS |
| SubagentStop shape | PASS (4 stops: A 2, B 2) |
| Returns over 800 chars sent back once | PASS (A 1,322 → 502; B 842 → 405) |
| One `offloads.md` entry per agent, tagged `t<turn>@<session8>` | PASS |
| `queue/` holds at most the newest turn | PASS |
| Hand-back cap | PASS (no hand-backs) |

### Product fixes made during the run

1. **Agents used Bash on slate paths.** Fixed in `agents/offload.md` and `rules.md`. Tests: `test/packaging.test.mjs` and `test/inject.test.mjs`.
   - Cause: 2.1.308 has no Grep or Glob tool, so models search with Bash, and the default mode denies Bash outside the working folders.
   - In runs 1 and 2, A's agent sent `grep <project>; ls <slate>/reports` as one call to check the report path was free. The whole call was denied, so the agent decided Bash was off and wrote a "scan blocked" report.
   - offload.md now says to use only Read and Write on slate files, because a Bash call naming a slate path is denied whole. It drops the pre-check: Write won't replace an unread file, so it guards on its own. It also says past reports are found through `offloads.md`.
   - rules.md now says "Bash there is denied" and that `offloads.md` lists report paths. It's 1,692 chars with 120-char paths; to fit, three phrases were shortened with no change in meaning.
2. **The link reply restated the rules.** Fixed in `skills/link/SKILL.md` (test: `test/packaging.test.mjs`). In run 2 both sessions replied with the rules as bullets. The skill now says to reply with one line and nothing else.

### Bash on slate paths

**Ruling: keep it as is.** Slate doesn't add a Bash allow-list or a working-folder hook, because either one widens what gets approved automatically, and that's the user's call. The instruction fixes stay. Check 3c fails only when the hook should have allowed a call (Read, Write or Edit). Denied Bash calls on the slate are counted as a note.

The probes ran in haiku, in the default mode, as `-p` runs, at about $0.01 in all.

| Probe | Result |
|---|---|
| Tool list | Bash, Read, Write and Edit; no Grep or Glob |
| `grep -rn 'TODO(perf)' <project>` | allowed |
| `find <project> -name '*.rs'` | allowed |
| `ls <slate>/reports` | denied |

- The permission hook matches `Read|Write|Edit|Grep|Glob`, so on 2.1.308 its Grep and Glob branches never run. Listing or searching the slate always goes through Bash.
- Even after the instruction fixes, agents still sometimes try Bash first: that's the one denial in run 3. Recovery through `offloads.md` takes about 2 s. In an interactive session, it would be one permission prompt.
- A user can avoid the prompt by adding `~/slate` to `permissions.additionalDirectories`.
- Options considered and declined:
  - A `PermissionRequest` hook that adds the slate as a working folder. In 2.1.308 its `allow` also approves the call that asked, and in `acceptEdits` mode it makes the whole slate editable without a prompt.
  - A PreToolUse allow-list for read-only Bash inside the slate, which needs our own shell parsing.

### Run 3: memory and logs

```
# Instructions
- [I2 t1@b2d166d7] Release branches are always named release/<version>.
- [I3 t3@055db07f] For this project, always give package-manager commands using pnpm.

# Facts
- [F1 t1@055db07f] The staging host is stg-7.internal. (user)
- [F2 t1@b2d166d7] The current release branch is release/2.4. (user)

# Superseded
- [I1 t1@055db07f retired t3@055db07f] For this project, always give package-manager commands using npm. (reason: user switched project to pnpm)
```

`assumptions.md` stayed empty. A's `now.md` holds a Goal / Focus / Open / Next for the TODO(perf) summary. B's `now.md` stayed empty, because its curator applied nothing for t2 and t3 (not asserted).

```
A  19:46:18.419Z t1 ok: attempt 1: applied 0:add I1, 1:add F1
B  19:46:21.623Z t1 ok: attempt 1: applied 0:add I2, 1:add F2
A  19:46:35.789Z t2 ok: attempt 1: applied 0:now
A  19:47:04.489Z t2 ok: attempt 1: applied 0:now            (continuation: the agent's result)
B  19:47:17.490Z t2 ok: attempt 1: applied nothing
A  19:47:20.871Z t3 ok: attempt 1: applied 0:replace I1 I3, 1:now
B  19:47:28.395Z t3 ok: attempt 1: applied nothing
A  19:47:32.535Z t4 ok: attempt 1: applied nothing
```

`offloads.md` has two entries: `## t2@055db07f … a0c43b30731e31b27` (A's scan, whose return names `reports/todo-perf-scan.md`) and `## t2@b2d166d7 … aa8844c0efe81b862` (B's lookup).

### Run 3: timings

| Turn | A `-p` | A curator wait | B turn |
|---|---|---|---|
| 1 | 5.9 s | 0.8 s | 5.7 s |
| 2 | 3.4 s | 5.3 s | 4.5 s |
| 3 | 33.2 s | 12.8 s | 23.5 s |
| 4 | 6.0 s | 10.5 s | 4.5 s |
| 5 | 3.8 s | 8.3 s | |

All curator children ran `~/.local/bin/claude` (executable `~/.local/share/claude/versions/2.1.308`) with `-p … --model sonnet --json-schema`.

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

**Shared slates runs (2026-10-22): left in place** for the same reason. Remove by hand:

- **Run 1:** `<tmp>/slate-home-Cu1lTy`, `<tmp>/slate-acc-UQjnE4`, `<tmp>/slate-acc-b-RyqUdK` and `<tmp>/slate-probe-yzQuOP`
- **Run 2:** `<tmp>/slate-home-g3f0mU`, `<tmp>/slate-acc-223Gzw`, `<tmp>/slate-acc-b-xQ0beI` and `<tmp>/slate-probe-09CzMb`
- **Run 3:** `<tmp>/slate-home-F0LVBs`, `<tmp>/slate-acc-FWaFq2`, `<tmp>/slate-acc-b-f05W0q` and `<tmp>/slate-probe-SQMjxs`
- `~/.claude/projects/-private-var-folders-…-T-slate-acc-{UQjnE4,223Gzw,FWaFq2}` and `…-slate-acc-b-{RyqUdK,xQ0beI,f05W0q}`
- `~/.claude/projects/-private-tmp-claude-<uid>-…-scratchpad-live-streamprobe-cwd`, from the stream-json probe. The Bash probes kept no transcript.

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
