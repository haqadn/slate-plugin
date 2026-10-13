# slate plugin — design

A Claude Code plugin that keeps the main thread small. It offloads high-context turns to subagents and keeps instructions, facts and focus in curated per-session files. Those files survive `/clear` and compaction.

## Goal

Long brainstorming and coding sessions without context rot:
- A detail the user gave is never silently lost.
- Superseded instructions never get injected back into context, and stop steering output once `/clear` or compaction drops the old message.
- Turns that would pull in lots of throwaway material run in subagents, so their output never reaches the main thread.
- Replies are short and colleague-style.

## Non-goals (v1)

- Memory shared across sessions. Each slate session is self-contained; lasting rules belong in CLAUDE.md.
- `topics/` files. Add them when a real session outgrows the 10k load limit.
- Setting `autoCompactWindow` automatically. Plugins can't set it; the README tells the user how.
- Codex, Windows, a way to turn slate off mid-session (delete the folder by hand).

## User flow

1. In any Claude Code session, the user runs `/slate:init`. That session now has `.slate/<session_id>/`. Other sessions in the same project are unaffected.
2. Each message is recorded. Heavy work goes to the `offload` agent. After each answer, a background curator updates the memory files.
3. `/clear`, compaction or resume reloads the curated memory, so the session continues without the old conversation.

## Layout

```
.slate/
  .gitignore          "*", written only when .slate/ is first created; never recreated
  <session_id>/
    session.json      Claude Code process ID, created, inherited-from, turn counter, IDs last shown
    instructions.md   I items: standing rules from the user
    assumptions.md    A items: the model's unverified guesses
    facts.md          F items: verified, each ending with a source, e.g. "(package.json)"
    now.md            goal / focus / open questions / next step, ≤10 lines
    superseded.md     retired items, append-only
    conversation/     NNNN.md per turn: message (written on send) + answer (written on stop)
    reports/          <slug>.md written by offload agents
    handbacks/        <agent_id> markers: offload hand-backs already sent back once (return cap)
    curated.json      curator queue mark: last curated turn, its file size, and a turn to retry after an error
    curator.log       one line per curator result: ok, retry, restored, error, aborted
                      (restored and error show as warnings; aborted = requeued, not shown)
    curator.lock      present while a curator runs (holds its pid)
```

**Item line:** `- [I12 t3] text`. That is the type, the ID and the turn it came from. IDs are never reused.

**Retired line:** `- [I1 t1 retired t2] text (reason: why)`.

**Hand edits:** a plain bullet without an ID was added by the user. The curator adopts it with the next ID and `t0`, keeping its text exactly.

## Plugin parts

| Part | Job |
|---|---|
| Skill `init` (`/slate:init`) | Only the user can run it (`disable-model-invocation`). Runs the init script for this session. Creates the folder and `session.json`, plus `.slate/.gitignore` if `.slate/` is new. Loads the rules into context. If the folder already exists, says slate is already active. |
| SessionStart hook (`startup\|resume\|clear\|compact\|fork`) | Handles the folder (see Lifecycle). If this session has a folder, injects the memory block. |
| UserPromptSubmit hook | Waits up to 20s for a running curator. Increments the turn and writes the message verbatim to `conversation/NNNN.md`. Injects the change line. Two kinds of prompt are not turns: `/slate:` commands (nothing recorded, no output), and harness messages (`<task-notification`, `<agent-message`, `<cross-session-message`, `<teammate-message`, `[SYSTEM NOTIFICATION`), whose following answer is appended to the current turn as a continuation. |
| Stop hook | Appends `last_assistant_message` to `conversation/NNNN.md`. Starts a curator drain detached, then returns immediately. |
| PreCompact hook | Waits up to 60s for a running curator. Never blocks compaction. |
| Return cap (best-effort) | Sends an offload return over 800 chars back once, for a rewrite in ≤600 chars. Enforced on the final text by the SubagentStop hook (matcher `slate:offload`), and on `SubagentHandback.message` by the PreToolUse hook (matcher `SubagentHandback`; denies once per agent, marker `handbacks/<agent_id>`). Other return channels rely on the instruction in `offload.md`. |
| Curator (`scripts/curate.mjs`) | Snapshot, then a `claude -p` edit pass, then the safety check, then keep or restore |
| Agent `offload` | For slate sessions only; its description says to use it when the brief gives `.slate/` paths. Reads the memory files named in its brief and does the heavy task. Writes details to `reports/<slug>.md`, returns ≤10 lines, and never edits memory files. |
| `rules.md` | One source for the main-thread rules. Used by the init skill and by the SessionStart block. |

Every hook exits 0 immediately with no output if the session has no folder, or if `SLATE_CURATOR=1` is set (that is, it runs inside the curator). The one exception is SessionStart without a folder: it may first release the process ID (see Lifecycle), or move or copy a folder on `clear` and `fork`. Hooks never exit 2.

## Lifecycle

| Event | Action |
|---|---|
| `startup` | New session ID, no folder. Release the current Claude Code process ID: set `pid` to null in any folder holding it. |
| `resume` | Same ID. With a folder: write the current process ID into `session.json` (a `--resume` runs in a new process), release it from every other folder, inject the block. Without a folder (an in-process `/resume` to a session without slate): release the process ID, as for `startup`. |
| `clear` | New session ID. Find the folder whose `session.json` holds the current process ID, abort its running curator if it doesn't finish within 20s, rename the folder to the new ID, record `from`, inject the block. If none matches, do nothing. |
| `compact` | Same ID. Inject the block, headed "Memory below wins where it differs from the summary." |
| `fork` | New ID. Find the parent's folder by process ID as for `clear` (an in-process `/branch` keeps the process). Abort its running curator if it doesn't finish within 5s, copy the folder, inject the block. No match (`--fork-session`, a new process): do nothing; the user can run `/slate:init`. |

A folder without a pid is never matched. Releasing the pid keeps `/clear` and `/branch` from moving or copying a folder into a session that switched away from it.

After injecting the block, SessionStart starts a curator drain if turns are left uncurated and no curator holds the lock (for example, the turn a `/clear` aborted). The drain starts after the block is built, so the block never reads an unchecked edit.

## What enters the main thread

| When | Content | Budget |
|---|---|---|
| `/slate:init` | Rules plus the session folder path. Memory starts empty. | ~1–2k chars, once |
| SessionStart (`resume`, `clear`, `compact`, `fork`) | Rules, then instructions, now, facts, assumptions | ≤10,000 chars (the hook cap). If over: instructions and now in full, facts and assumptions as file paths. |
| SessionStart, when memory lags | One line under the heading: `slate: memory may not include turn N yet — read <dir>/conversation/NNNN.md before acting on recent instructions.` (a range for several turns), prefixed `memory still updating;` when a curator still holds the lock after the wait | one line |
| Each message | One-line reminder, plus changes since the last injection (`+I14 Use pnpm · retired I3`), or `memory still updating` while a curator holds the lock, plus any curator warnings | ~100–300 chars |
| Each offload | The agent's summary | ≤10 lines |

Retired items appear only as IDs in the change line, never as text. `superseded.md`, `conversation/` and `reports/` are opened only on demand.

**Main-thread rules (`rules.md`):**
- Reply like a colleague: short and plain. Lead with the answer, no essay. An explicit request for detail wins.
- **Offload to `offload`:** broad searches, more than a couple of files, logs, test or build output, web research, multi-file reviews.
- **Keep in the main thread:** conversation, decisions, small targeted reads.
- **Brief format:** "Read `.slate/<id>/instructions.md`, `facts.md`, `now.md`. Task: … Write details to `.slate/<id>/reports/<slug>.md`. Return ≤10 lines." Point at the files; never retell instructions in a brief.
- Memory files are read-only for you and for subagents. The curator maintains them.
- Memory files override earlier conversation where they differ.
- Open `superseded.md` only to learn why something changed.
- Don't save notes to CLAUDE.md, AGENTS.md or any other memory file; slate keeps memory.

## Curator

**Command:** `claude -p <prompt> --model <curatorModel> --setting-sources "" --settings '{"disableAllHooks":true}' --strict-mcp-config --disable-slash-commands --no-session-persistence --permission-mode dontAsk --tools Read,Edit,Write --allowedTools <rules>`. The rules are `Read(/<abs>)` and `Edit(/<abs>)` for each of the five memory files (realpath; an `Edit` rule also covers Write), so edit rights stop at those files. `--setting-sources ""` keeps allow rules from the user's settings out, and with them any `apiKeyHelper` auth. Env: `SLATE_CURATOR=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, without the parent session's identity variables. Stdin is ignored. It is spawned detached so it survives the hook returning. `curatorModel` is a plugin setting, default `sonnet`.

**Queue (drain):** each Stop starts `curate.mjs`, which takes `curator.lock` and curates every pending turn in order. `curated.json` records the last turn done and its file size; a turn file that grew (a continuation) is curated again. The newest turn waits for its answer; an older one without an answer is curated with a placeholder. A drain that finds the lock held exits at once, and the holder rechecks the queue after releasing it. SIGTERM (from a `clear` or `fork` SessionStart) aborts the run: the edit is undone, `aborted` is logged and the turn stays queued.

**Input:** the curator rules, the turn number, the message verbatim, the final answer, and the paths of the memory files (it reads them itself).

**Rules:**
- One idea per item, no fluff. Copy the user's specifics verbatim: names, numbers, paths, phrasing that matters.
- An I item is a standing rule for future turns ("always", "from now on", "never", preferences). A one-off request goes in `now`.
- Never reword an existing item. To change one, move its line to `superseded.md` as `retired t<N>` with a reason, then add a new item.
- A new item states only the current rule, without naming what it replaced, unless the user's instruction is itself a prohibition.
- New IDs take the next number for their type. Facts need a source, and never point to a report file or a `.slate/` path (the folder is renamed on `/clear`).
- Adopt plain user bullets with `t0`, text unchanged.
- `now.md` stays at 10 lines or fewer. If nothing changed, change nothing.

**Safety check** (a script, run after the curator):
1. Every ID live before is live after with identical text, or is in `superseded.md` with identical text, `retired t<N>` and a non-empty reason.
2. `superseded.md` only gained lines.
3. New IDs are unique, above the previous maximum for their type, and tagged `t<N>`.
4. Every plain user bullet from before still exists word for word, adopted or not. Trailing whitespace doesn't count, for plain lines only; item text compares exactly.
5. All memory files parse, and `now.md` has 10 lines or fewer. A new line in an item file that carries retired text (a retired-style tag, or a note like `(retired I1)`) fails as a malformed item line; injection never shows such lines.

Hooks may write `conversation/` and `session.json` while a curator runs, so the check covers only the five memory files. The curator's permissions keep it out of everything else, and a restore rewrites only those five files.

On failure, retry once with the failures listed. If it fails again, restore the snapshot, log `restored` to `curator.log`, and show a warning in the next change line; the turn is done. A run that errors (crash, timeout, missing binary) is logged as `error`, shown as a warning, and stays queued once: the next drain, or the same drain if a Stop came in meanwhile, retries it, and a second error marks it done. A lock held by a dead pid is taken over.

## Install

The repo is `~/Projects/slate-plugin`, laid out as a local marketplace: `.claude-plugin/marketplace.json`, `plugins/slate/`.

- **Install:** `claude plugin marketplace add ~/Projects/slate-plugin`, then `claude plugin install slate@slate-plugin`.
- **Develop:** `claude --plugin-dir plugins/slate`, `/reload-plugins` after edits, and `claude plugin validate`.
- **Runtime:** plain Node `.mjs` scripts, no dependencies, tested with `node:test`.
- **README** (one screen): `/slate:init`, recommending `/autocompact 100000` so compaction becomes the automatic reset, hand edits, and the layout.

## Testing

- **Unit:**
  - the line format
  - each safety-check rule, with passing and failing cases
  - the `/clear` move matched by process ID, and the fork copy
  - the SessionStart block stays ≤10k and never contains retired text
  - the change-line diff
- **Hook scripts:** fed fake hook-input JSON on stdin; tests check the stdout JSON and the files written. Also covered: the recursion guard, and that the Stop hook returns in under 1s while a fake curator sleeps.
- **Curator:** run against a fake `claude` that makes good and bad edits. Tests check that the safety check keeps or restores, and that it logs.
- **Live acceptance** (opt-in, real model; `claude -p --plugin-dir … --session-id <uuid>`, then `--resume <uuid>`): `/slate:init`, then "use npm", then a heavy search task, then "switch to pnpm", then "what installs lodash?". It passes when:
  - The main transcript has no large tool results from the search; it went through `offload`.
  - No `offload` brief after the switch mentions npm.
  - npm appears only in `superseded.md`, and the answer uses pnpm.
  - The detail from the first message is still in memory.
- **Manual:** one interactive session to check the `/clear` move and the compaction reload.

## Verified platform facts (Claude Code 2.1.292)

- **Hook input:**
  - `UserPromptSubmit` gets `prompt`.
  - `Stop` gets `last_assistant_message` (use it; the transcript may lag).
  - `SessionStart` gets `source`: `startup|resume|clear|compact|fork`.
  - All hooks get `session_id` and `cwd`.
- **Context injection:** `hookSpecificOutput.additionalContext`, capped at 10,000 chars per hook.
- **Timeouts:** `UserPromptSubmit` defaults to 30s, `command` hooks to 600s.
- **Compaction:** `PreCompact` can only block it, not change the summary. `SessionStart` with `compact` is the way to inject afterwards.
- **Recursion:** a nested `claude -p` loads hooks unless given `--settings '{"disableAllHooks":true}'`.
- **Auto-memory:** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns off Claude's auto-memory.
- **Session IDs:** `/clear` starts a new session ID; compaction keeps it.

## To verify during implementation

All answered in `docs/verified.md`.

- How `/slate:init` gets its session ID: does skill content support `${CLAUDE_SESSION_ID}`? Otherwise, the UserPromptSubmit hook can catch the `/slate:init` prompt.
- How to find the Claude Code process ID from a hook: the ancestor process chain.
- What `fork` input provides to identify the parent session.
- That a detached `setsid nohup` curator survives the hook returning and the user exiting.
- Exact path-scoped permission syntax to limit the curator's Edit and Write to the five files.
- The plugin `userConfig` schema for `curatorModel`.
- That `resume` keeps the session ID.

## Definition of done

- `/slate:init` works in a session, and hooks do nothing in sessions without it.
- After each turn: the message and answer are saved, the curator runs in the background, and the safety check either keeps or restores.
- `/clear` moves the folder and reloads memory. Compaction reloads memory.
- Unit and hook tests pass. The live acceptance run passes all four checks. The manual `/clear` and compaction check is done.
- README and `claude plugin validate` are clean.
