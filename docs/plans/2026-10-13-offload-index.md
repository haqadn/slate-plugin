# Offload index and turn queue — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every `slate:offload` run as a pointer to its transcript, and turn `conversation/` into a curator queue whose files are deleted once curated.

**Architecture:** The SubagentStop hook appends one entry per offload to `offloads.md`; the PreToolUse hook saves an allowed hand-back message for it. The drain deletes curated turn files older than the newest turn. Rules and the offload agent learn where past runs are.

**Tech Stack:** Node ≥ 24, ESM `.mjs`, `node:test`, no dependencies.

**Spec:** `docs/specs/2026-10-13-offload-index-design.md`, which amends `docs/specs/2026-10-07-slate-plugin-design.md`. Read both.

**Level of detail:** deliverables, interfaces, test cases and acceptance checks. Code inside a function is the implementer's call.

## Global Constraints

- Hooks never exit 2. A hook does nothing without a session folder or with `SLATE_CURATOR=1`.
- Only `/slate:init` and the curator write the five memory files. `offloads.md` and `queue/` are hook-owned.
- `rules.md` stays ≤ 1,500 chars with a 120-char folder path, and keeps exactly three `{{dir}}` (test in `test/inject.test.mjs`). Name `offloads.md` bare; the rules' first line says files are in the folder.
- Test command: `npm test`.
- Commit after each task. End commit messages with the session's attribution lines.

## Review Focus

1. **Return text shaped like an entry header** (a line starting `## t`): must stay inside its entry. Test in Task 2.
2. **A follow-up appended while the curator runs on the newest turn**: must not be lost or deleted. Test in Task 1.
3. **A session folder from before this change** (has `conversation/`, no `queue/`): the next message must still be recorded and curated. Test in Task 1.
4. **Two offloads finishing at once**: both entries land whole. Test in Task 2 (two concurrent appends).
5. **A hand-back agent denied once, then allowed**: the entry holds the allowed (second) message. Test in Task 2.

---

### Task 1: Turn queue

**Files:**
- Modify: `plugins/slate/scripts/lib/session.mjs` (turn file path, `initSession`, writers, new sweep)
- Modify: `plugins/slate/scripts/curate.mjs` (prompt path, sweep after each done turn)
- Modify: `plugins/slate/scripts/lib/inject.mjs` (`lagLine` path)
- Modify: `plugins/slate/rules.md` (drop the `conversation/NNNN.md` clause)
- Modify: `README.md` (layout table), `docs/specs/2026-10-07-slate-plugin-design.md` (layout, hooks, rules; link the amendment)
- Test: `test/session.test.mjs`, `test/curate.test.mjs`, `test/inject.test.mjs`, `test/hook.test.mjs`

**Interfaces:**
- Produces: `queueFile(dir, turn) → string`, `<dir>/queue/NNNN.md` (exported; replaces the private `turnFile`).
- Produces: `sweepQueue(dir, upTo) → Promise<void>`. Deletes `queue/NNNN.md` for every turn ≤ `upTo`. Missing folder or files are fine.
- Unchanged signatures: `writeMessage`, `appendAnswer`, `turnState`, `readTurn`, `pendingTurns`. The writers create `queue/` if it's missing.

**Behavior:**
- `initSession` creates `queue/` instead of `conversation/`.
- In `drain`, after each `writeCurated(dir, work)`, call `sweepQueue(dir, Math.min(work.turn, lastTurn - 1))`, where `lastTurn` is `session.json`'s turn read at that moment. The newest turn's file is never swept. A parked turn (first error) and an aborted turn are not marked done, so they aren't swept.
- The curator prompt's truncation note and `lagLine` point at `queue/`.

- [ ] **Step 1: Failing tests.**
  - `initSession` makes `queue/`, not `conversation/`.
  - `writeMessage` into a folder without `queue/` creates it (old session folder).
  - `sweepQueue` deletes files ≤ `upTo` and leaves the rest. A missing folder is fine.
  - Drain over turns 1–3, all answered: afterwards only `queue/0003.md` remains.
  - Drain where the fake curator errors once on turn 2: `0002.md` is kept, and the turn is curated and swept on the next drain.
  - Drain where turn 2 is `restored`: `0002.md` is swept once turn 3 exists.
  - Aborted run on turn 1 of 2: `0001.md` is kept.
  - A continuation appended to the newest turn after it's curated: the file grows, and the next drain re-curates it whole (message and both answers in the prompt).
  - A continuation appended *while* the curator runs on the newest turn: the file is still there afterwards, and the turn is re-curated.
  - The lag line names `queue/` paths. The hook tests that read `conversation/` read `queue/`.
  - The rules test expects no `conversation/NNNN.md`.
- [ ] **Step 2: Run `npm test`.** The new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update docs.** README layout row: `queue/`, "your message and the answer, until curated (the newest stays until the next turn)". Main spec: amend the Layout, the UserPromptSubmit and Stop rows, and the rules bullet; add a line under the title linking `2026-10-13-offload-index-design.md`.
- [ ] **Step 5: Run `npm test`.** Everything passes.
- [ ] **Step 6: Commit** `Turn conversation/ into a curator queue`.

### Task 2: Offload index

**Files:**
- Modify: `plugins/slate/scripts/lib/session.mjs` (`appendOffload`)
- Modify: `plugins/slate/scripts/hook.mjs` (`subagentStop`, `preToolUse`)
- Modify: `plugins/slate/rules.md`, `plugins/slate/agents/offload.md`
- Modify: `README.md` (layout rows `offloads.md`, `handbacks/`), `docs/specs/2026-10-07-slate-plugin-design.md` (layout, return-cap row)
- Test: `test/session.test.mjs`, `test/hook.test.mjs`, `test/inject.test.mjs`, `test/packaging.test.mjs`

**Interfaces:**
- Produces: `appendOffload(dir, { turn, at, agentId, transcript, text }) → Promise<void>`. Appends one entry to `<dir>/offloads.md` with a single `appendFile` call, and writes a `# Offloads` title first if the file is new. Entry:

  ```
  ## t<turn> <at> <agentId>
  transcript: <transcript, or "none">

  > <each line of text>
  ```

  Every line of `text` gets `> ` (a blank line gets `>`), so no return line can start an entry. `transcript` is made one line. An empty `text` is written as `> (no return text)`.
- Consumes: `readSession(dir).turn` for the turn number.
- Hand-back stash: `handbacks/<agent_id>.return`, the last hand-back message PreToolUse let through for that agent.

**Behavior:**
- `subagentStop(input, dir)` becomes async. When `agent_type` is `slate:offload` and the stop is not blocked: entry `text` is `last_assistant_message` if it's a string, else the contents of `handbacks/<agent_id>.return` if present, else empty. `transcript` is `agent_transcript_path` if it's a string. A blocked stop writes nothing. The agent ID must pass `SAFE_ID`, else no entry.
- `preToolUse`: whenever it lets an offload's `SubagentHandback` through (short message, or the second attempt), it writes the message to `handbacks/<agent_id>.return`, overwriting any earlier one. A failed write never blocks the hand-back.
- `rules.md`, one line: past offloads, each with its return and transcript path, are listed in `offloads.md`; to dig into one, brief `slate:offload` with its transcript path.
- `offload.md`, one line: a `.jsonl` transcript path in the brief is a past run; search it for the tool calls and outputs you need, don't read it whole.

- [ ] **Step 1: Failing tests.**
  - `appendOffload`: the first entry adds the title and later ones don't. A return line `## t9 x y` comes out as `> ## t9 x y`. Blank lines and empty text are handled. A transcript with a newline stays on one line. Two concurrent calls leave two whole entries.
  - SubagentStop for `slate:offload` with a short final text: one entry with the turn, the agent ID, the transcript path and the text, and no output.
  - Over the limit: blocked, no entry. The next stop (`stop_hook_active`): one entry.
  - Another `agent_type`, or an empty one: no entry.
  - No folder: no entry, no output.
  - Hand-back flow: a PreToolUse with a short message saves `.return`, and SubagentStop without `last_assistant_message` writes that message.
  - Deny-then-allow: the entry holds the second message.
  - No `agent_transcript_path`: `transcript: none`.
  - Unsafe agent ID: no entry.
  - The rules test expects `offloads.md`. The packaging test expects the transcript line in `offload.md`. The rules stay ≤ 1,500 chars.
- [ ] **Step 2: Run `npm test`.** The new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update docs.** README rows: `offloads.md` ("one entry per offload run: return and transcript path"); `handbacks/` ("… plus the last hand-back message let through, per agent"). Main spec: the same in Layout, and the SubagentStop part of the return-cap row records the entry.
- [ ] **Step 5: Run `npm test`.** Everything passes.
- [ ] **Step 6: Commit** `Record each offload run in offloads.md`.

### Task 3: Live acceptance

**Files:**
- Modify: `test/live/acceptance.mjs`
- Modify: `docs/acceptance.md` (append this run's results), `docs/verified.md` (add the findings below)

**Interfaces:**
- Consumes: `offloads.md` entry format from Task 2; `queue/` from Task 1.

**New checks** (hard unless noted):
- Each `slate:offload` call in the main transcript has one `offloads.md` entry, and its transcript path exists and contains at least one tool call.
- After the run, `queue/` holds at most the newest turn's file.
- `--real-settings` pass (soft): the same entry check, which covers the hand-back path when it happens. Record whether it did.
- The results JSON lists `queue` instead of `conversation`.

- [ ] **Step 1: Add the checks.**
- [ ] **Step 2: Run** `node test/live/acceptance.mjs --live --out <scratch>/default.json`, then `node test/live/acceptance.mjs --live --real-settings --out <scratch>/real.json`. Real model calls. Run them through a subagent so the output stays out of the main thread.
- [ ] **Step 3: Record.** Add the results to `docs/acceptance.md`. Add to `docs/verified.md`: whether `agent_transcript_path` was set for background and hand-back returns, and whether the offload agent could read a transcript path outside the project. If it couldn't, add a follow-up to `docs/follow-ups.md`.
- [ ] **Step 4: Clean up** the temp project and `~/.claude/projects/<slug>/` that the script prints.
- [ ] **Step 5: Commit** `Live acceptance for offload index and queue`.

## Definition of Done

- Every `slate:offload` run in a slate session leaves one `offloads.md` entry with a working transcript path.
- No turn file outlives its curation, except the newest turn's, until the next turn.
- `rules.md`, `offload.md`, README and the main spec reflect the change.
- `npm test` passes. Both live runs pass their hard checks.
