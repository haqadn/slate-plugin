# Shared slates — design

Changes the [slate plugin design](2026-10-07-slate-plugin-design.md) and the [offload index design](2026-10-13-offload-index-design.md). Anything not named here is unchanged.

## Why

Slate memory is tied to one session, in the project's `.slate/<session_id>/`. Work on one topic spans several sessions running in parallel: a lead session plus peers for a PR, a sandbox check, a bug. Each peer starts from nothing. Every session also leaves a folder behind in the project.

## Goals

- One named slate per topic, `~/slate/<name>/`, shared by every session linked to it.
- Sessions on one slate run in parallel without losing or clobbering each other's memory.
- Offloading stays. Offload agents read the slate directly. Reports and the offload index are shared.
- Cleanup means one visible folder per topic. Nothing is written into project folders.

## Non-goals

- A session linked to several slates at once.
- Syncing slates across machines.
- Migrating old `.slate/` folders in general. One folder is migrated (see Migration).
- Splitting facts into topic files. Facts over the injection cap already go in as a path.

## Anti-goals

Any of these is a failure even if everything else works:

- One session's one-off request becomes a rule for every session.
- Two curators finish at once and one's changes are lost, or an ID is used twice.
- A permission prompt on slate reads or offload report writes.
- Files written into project folders.

## User flow

1. In any session, the user runs `/slate:link jetpack-seo`. The slate is created if new (after a confirmation), the session is linked, and rules plus memory load.
2. `/slate:link` with no name shows a picker.
3. Work goes on as today. Rules that other sessions add show up in the per-message `slate:` line.
4. When the topic is finished, `/slate:done jetpack-seo` deletes the slate.

## Layout

```
~/slate/                       root; SLATE_HOME overrides it (tests)
  <name>/
    instructions.md            shared I items
    assumptions.md             shared A items
    facts.md                   shared F items
    superseded.md              shared, append-only
    reports/                   offload reports from every session
    offloads.md                offload index from every session; each entry names its session
    memory.lock                held only while a change list is applied
    .sessions/
      <session_id>/
        session.json           pid, created, from, turn, IDs last shown
        now.md                 this session's goal, focus, open questions, next step (≤10 lines)
        queue/  curated.json  curator.log  curator.lock  handbacks/     as today
```

- A session is linked when a `.sessions/<session_id>/` folder (not detached) exists under some slate. There is no separate registry.
- Slate names: lowercase letters, digits and dashes.

## Commands

Both are user-only (`disable-model-invocation`). `/slate:init` is removed.

### `/slate:link [name]`

| Case | Behavior |
|---|---|
| No name | Picker (AskUserQuestion): up to three most recently used slates, plus a name suggested from the conversation, or from the project and branch when the conversation is empty. "Other" lets the user type a name. Then continues as one of the cases below. |
| Existing slate | Link. Load the rules and the memory block. Reply with one line. |
| New name | Ask before creating. If an existing name is close (a likely typo), name it. Create on yes, then link. |
| Already linked to this slate | Say so, and load the rules and the memory block again (this refreshes paths after a migration or a plugin reload). |
| Linked to another slate | Switch. The old session folder is detached: kept, ignored by lookup, swept later. A new session folder starts in the new slate with an empty `now.md`. |

### `/slate:done [name]`

- No name means this session's slate.
- Asks for confirmation.
- Refuses while another live session is linked (its process is alive and it isn't this session), and names those sessions.
- Aborts the slate's running curators, then deletes the slate folder. If this session was linked to it, slate is off for this session.

## Parallel sessions: the curator returns a change list

The curator no longer edits files. It reads memory and returns a change list. A script applies the list.

- **Curator:** read-only tools, no write tools. It reads the shared memory files and its own session's `now.md`. It returns a structured change list (`claude -p --json-schema`).
- **Operations:** `add` (type, text), `retire` (ID, reason), `replace` (ID, new text, reason; a retire plus an add), `now` (the full new `now.md`, ≤10 lines). The apply script adopts plain user bullets itself; the model doesn't.
- **Apply script:** takes `memory.lock`, rereads the files, validates each operation, applies, writes each changed file atomically (temp file plus rename), and releases the lock. The lock is held for milliseconds.
- **Guarantees by construction:** a live line is never rewritten or deleted, only retired. `superseded.md` is only appended to. The script assigns IDs, above every ID ever used in the slate, so two sessions can't take the same one. This replaces most of today's safety check, and the snapshot and restore.
- **Stale view:** the curator's read can be seconds old. An add whose text matches a live item exactly is skipped. A retire or replace of an ID that's no longer live (another session changed it first) triggers the retry below, so the curator sees the fresh memory and can replace the newer item instead. If it's still stale after the retry, the add half of a replace is applied anyway and a warning is shown: a user's instruction is never silently dropped.
- **Validation:** item text is one line, has no retired-style tags, and a fact ends with a source in parentheses that isn't a report or slate path. `now` has 10 lines or fewer.
- **Invalid operations:** retry once with the errors listed and the memory reread. If the retry is still invalid, apply the valid operations, drop the rest, and log a warning shown in the next change line.
- **Origin tags:** a new item records the session and turn it came from. Existing tags (`t12`, `t0`) must still parse. The exact format is the builder's call.
- **Per-session order is unchanged:** each session drains its own queue under its own `curator.lock`. Different sessions' curators run in parallel; only the apply step takes turns.
- **New curator rule:** instructions are shared by every session. A standing rule tied to one task names that task in its text ("For wpcom#249668: never touch X"), so other sessions read it as scoped. A one-off request still goes in `now`. (Session-only rules are not put in `now.md`: it's capped at 10 lines and rewritten as focus moves, so they'd be lost without a trace.)

## What each session sees

- **Memory block:** rules, shared instructions, this session's `now.md`, shared facts and assumptions. The budget and over-cap fallback are as today.
- **Change line:** each session diffs against its own "IDs last shown", so items from other sessions appear as `+I14 …` on its next message.
- **Lag line and curator warnings:** this session's queue and `curator.log` only.
- **Offload index:** each entry also records its session ID.
- **Reports:** shared, so names must not collide across sessions. The offload agent never overwrites an existing report.

## Permissions

A new PreToolUse hook on Read, Write, Edit, Grep and Glob runs in linked sessions, for the main thread and subagents alike:

- Read, Grep and Glob anywhere inside the linked slate: allowed.
- Write and Edit under the slate's `reports/`: allowed.
- Anything else falls through to normal permissions. Memory files stay read-only for the main thread and agents.

**Verified 2026-10-22, Claude Code 2.1.308:** in `-p` mode with no hook, a read and two writes outside the project were denied, including the subagent's. With an allowing PreToolUse hook, all three succeeded in `-p` mode and in an interactive session (driven through a pty) with no permission prompt. The subagent's call reached the hook carrying its agent ID.

## Lifecycle

Same events as today. "Find the folder by process ID" now searches `.sessions/` in every slate.

| Event | Action |
|---|---|
| `startup` | Release the process ID, as today. Run the sweep. |
| `resume` | Same ID, folder found: rewrite the pid, inject the block. |
| `clear` | Rename the session folder within its slate. |
| `fork` (`/branch`) | Copy the session folder within its slate. A `--fork-session` in a new process does nothing; the user links again. |
| `compact` | Inject the block, as today. |

## Cleanup

- **Sweep** (at SessionStart): delete session folders, detached or not, whose `session.json` hasn't been written for 30 days and whose process isn't alive. Session data is never deleted when a session ends.
- `/slate:done` deletes the whole slate.
- Old `.slate/` folders in projects: hooks ignore them. The README says to delete them by hand.

## Migration (one-off)

- Source: `/Users/adnan/Projects/jetpack/.slate/82b3114c-5e73-4142-ae8c-b8564fbac2d9` (or its current name, if a `/clear` renamed it since). Target slate: `jetpack-seo`.
- Copy, don't move. Shared files go to `~/slate/jetpack-seo/`. Session files go to `.sessions/<session_id>/`. Skip `conversation/` (old format, unused).
- The session is open but the user won't use it until the migration is done, so it can run while the session is idle. Afterwards the user reloads plugins and runs `/slate:link jetpack-seo` in it, which reloads rules and memory with the new paths.
- Leave the old folder for the user to delete.
- A script or by hand: the builder's call. It is not a user command.

## Rules and agent text

- `rules.md`: shared files under the slate path, `now.md` under the session path. The brief names the shared files plus this session's `now.md`. Reports go to `<slate>/reports/`. The budget may grow; keep it as small as the content allows.
- `offload.md` description: use when the brief gives `~/slate/` paths.
- README: install, link, done, layout, cleanup, old folders.

## Unchanged

The return cap, queue recording and drain order, hand-back handling, the injection budget, and the curator model setting.

## Testing

- **Apply script:**
  - two processes applying at once lose nothing and never reuse an ID
  - a stale retire is skipped
  - a duplicate add is skipped
  - invalid operations are rejected, valid ones in the same list still apply
  - writes are atomic
  - plain bullets are adopted
- **Hooks:**
  - lookup finds a session in any slate and ignores detached folders
  - the permission hook allows only inside the linked slate, and writes only under `reports/`
  - every hook does nothing in an unlinked session
  - the sweep deletes only stale sessions whose process is dead
- **Link and done:** create with confirm, link to an existing slate, switch, already linked, done refused while a peer is live, done deletes.
- **Live acceptance** (opt-in), two `-p` sessions on one slate in parallel:
  - A says "use pnpm", and B's next message shows the `+I` line.
  - Both curators run at the same time; afterwards every item is present and IDs are unique.
  - An offload from A writes a report in the default permission mode with no denial, and B reads it.
  - The existing checks still pass, adapted.
- **Manual:** the interactive picker, `/clear` and compaction on a linked session, and resuming the migrated jetpack-seo session.

## Definition of done

- `/slate:link` creates, joins, picks and switches as described. `/slate:init` is gone.
- Two parallel sessions on one slate share instructions, facts, assumptions, reports and the offload index. Each keeps its own `now.md`.
- Concurrent curators never lose an item or reuse an ID, shown by a test.
- Nothing is written to project folders. Slate reads and report writes cause no permission prompt.
- `/slate:done` deletes the slate, and refuses while a peer is live.
- Session folders idle for 30 days are swept.
- jetpack-seo is migrated, and resuming that session loads its memory from `~/slate/jetpack-seo/`.
- `npm test` passes, the live acceptance run passes, and the specs, README, `rules.md` and `offload.md` are updated.
