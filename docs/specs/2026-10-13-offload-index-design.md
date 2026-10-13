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
- A turn's file is deleted once it's curated (kept, restored, or errored twice) and a newer turn exists. An aborted run, or a first error, leaves it queued.
- The newest turn's file stays until the next turn, because a late follow-up (a background agent finishing) still appends to it. If it grows after curation, the whole turn is curated again, as today. Deleting it at once would race with that append.
- The memory-lag line keeps pointing at queue files. They exist exactly while a turn is uncurated.
- `rules.md` drops "read `conversation/NNNN.md` for exact wording".
- Existing session folders: an old `conversation/` folder is left in place and ignored. Not migrated.

## Unchanged

Curator rules and safety check, memory files, injection budgets, lifecycle (`/clear` moves the folder with `offloads.md` and `queue/` inside), the return cap.

## Hand-back returns

SubagentStop has no `last_assistant_message` after a hand-back. The PreToolUse hook already sees `SubagentHandback.message`; when it lets one through, it saves it as `handbacks/<agent_id>.return`, and SubagentStop reads that.

## To verify (live run)

- `agent_transcript_path` is set at SubagentStop for a background agent and for a hand-back return, and the file exists afterwards. Only the pointer is stored, so the file needn't exist yet when the hook runs.
- An offload agent can read a transcript path from a brief (it sits outside the project).

## Testing

- **Hook:** an entry is written for `slate:offload` only; not on a blocked stop; on the stop after it; with the hand-back message when there's no final text; return text can't break the entry format.
- **Queue:** a curated turn's file is deleted once a newer turn exists, after `ok`, `restored` and a second `error`; kept after `aborted` and a first `error`; the newest turn's file stays and a late continuation re-curates it; the lag line names existing files.
- **Live acceptance:** one offload run leaves an entry whose transcript path exists and contains the run's tool calls. Existing checks still pass.

## Definition of done

- Every `slate:offload` run in a slate session leaves one `offloads.md` entry with a working transcript path.
- No user ↔ main turn file outlives its curation, except the newest turn's, until the next turn.
- `rules.md`, `offload.md`, README layout table and the main spec reflect the change.
- `npm test` passes; the live acceptance run passes, including the new check.
