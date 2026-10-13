# Offload index and turn queue — design

Changes to the [slate plugin design](2026-10-07-slate-plugin-design.md).

## Why

The main thread gets only a short summary from each offload. Later turns, main or offload, have no way back to the tool calls and outputs behind it. Meanwhile `conversation/` keeps a lasting copy of every user ↔ main exchange, which Claude Code already stores and slate doesn't need.

## Changes

| Area | Before | After |
|---|---|---|
| Offload runs | Not recorded | One entry per `slate:offload` run in `offloads.md`, pointing at Claude Code's transcript of it |
| User ↔ main turns | `conversation/NNNN.md`, kept forever | `queue/NNNN.md`, deleted once curated |

## 1. Offload index

**When:** a `slate:offload` agent finishes. The SubagentStop hook writes the entry, except on a stop it blocks for a long-return rewrite; the next stop writes it.

**File:** `.slate/<id>/offloads.md`, append-only. One entry per run:

- turn number (the session's current turn)
- time
- agent ID
- `agent_transcript_path`: Claude Code's own transcript of the run, with every tool call and output
- the return: the final text, or the hand-back message when the agent returned through `SubagentHandback`

Return text is written escaped so it can't fake an entry boundary.

**Use:**
- Not injected. `rules.md` gets one line: past offloads are listed in `offloads.md`; to dig into one, brief an offload agent with its transcript path.
- `offload.md` says a transcript path in the brief is a JSONL file to search for tool calls and outputs.

**Scope:** only `agent_type` `slate:offload`. Internal agents and other agent types are not recorded.

**Accepted limit:** Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). Older entries keep the return text but lose the transcript.

## 2. Turn queue

- `conversation/` is renamed `queue/`. Recording is unchanged: message on send, answer on Stop, continuation after a harness message.
- A turn's file is deleted once it's curated, whatever the result: kept, restored, or errored twice. An aborted run leaves it queued.
- A continuation that arrives after its turn was curated is queued on its own. The curator gets the answer only, marked as continuing that turn, and is told the message was already curated.
- The memory-lag line keeps pointing at queue files. They exist exactly while a turn is uncurated.
- `rules.md` drops "read `conversation/NNNN.md` for exact wording".
- Existing session folders: an old `conversation/` folder is left in place and ignored. Not migrated.

## Unchanged

Curator rules and safety check, memory files, injection budgets, lifecycle (`/clear` moves the folder with `offloads.md` and `queue/` inside), the return cap.

## To verify first

- `agent_transcript_path` is set, and the file exists, at SubagentStop for a foreground agent, a background agent, and a hand-back return.
- Where the hand-back message can be read at SubagentStop time (the PreToolUse hook sees it; SubagentStop has no `last_assistant_message`).

## Testing

- **Hook:** an entry is written for `slate:offload` only; not on a blocked stop; on the stop after it; with the hand-back message when there's no final text; return text can't break the entry format.
- **Queue:** a turn file is deleted after `ok`, `restored` and a second `error`; kept after `aborted` and a first `error`; a late continuation is curated alone; the lag line names existing files.
- **Live acceptance:** one offload run leaves an entry whose transcript path exists and contains the run's tool calls. Existing checks still pass.

## Definition of done

- Every `slate:offload` run in a slate session leaves one `offloads.md` entry with a working transcript path.
- No user ↔ main turn file outlives its curation.
- `rules.md`, `offload.md`, README layout table and the main spec reflect the change.
- `npm test` passes; the live acceptance run passes, including the new check.
