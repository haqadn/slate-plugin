# slate

A Claude Code and Codex plugin that keeps the main thread small. Heavy work goes to subagents; instructions, facts and focus live in curated files that survive compaction. Files are grouped in shared topic slates under `~/slate/` (`SLATE_HOME` overrides it). Both hosts can share the same slate.

## Install

Requires Node.js 24 or newer.

### Claude Code

```
claude plugin marketplace add ~/Projects/slate-plugin
claude plugin install slate@slate-plugin
```

### Codex

Requires a Codex release with plugin lifecycle hooks and `codex exec --ignore-user-config` (tested with CLI 0.166.0), installed and signed in with `codex login`.

```
codex plugin marketplace add ~/Projects/slate-plugin
codex plugin add slate@slate-plugin
```

Restart Codex, then review and trust Slate's hooks with `/hooks` in the CLI, or **Settings > Hooks** in the desktop app. Until trusted, the link skill works but automatic capture, curation and memory reload do not. Local plugin command hooks require local orchestration; cloud-orchestrated threads do not run them. See the [Codex hook documentation](https://developers.openai.com/codex/hooks).

Select Slate's `link` skill in the skills picker and give a slate name (or ask it to offer a picker). Use Slate's `done` skill to delete a finished slate after confirmation. Its `offload` skill supplies the procedure for delegated work; it uses Codex's available subagents rather than a Claude agent profile.

Codex resume and compaction reload the linked memory. New and forked threads link explicitly: a shared Codex daemon PID cannot identify which thread's slate to inherit. Active threads prevent deletion or cleanup of their slate sessions until they end or switch slates. If a thread crashes without a `SessionEnd` hook, resume and end it normally to release its active marker.

Codex's curator uses `codex exec` with a read-only sandbox, hooks disabled, no user configuration and no saved session. It reuses CLI authentication; Claude is not required. Set `SLATE_CODEX_MODEL` in Codex's launch environment to choose a curator model, or leave it unset for the CLI's default. `SLATE_CODEX_BIN` overrides the `codex` executable on PATH. Export `SLATE_HOME` in that same environment if desired. The thread's tools need permission to write to the chosen slate directory (for CLI sessions, `codex --add-dir ~/slate` adds it to the workspace).

## Use

In Claude Code:

- `/slate:link [name]` links this session to a slate (new names ask first; no name shows a picker). Several sessions can share one slate.
- `/slate:done [name]` deletes a finished slate.
- Run `/autocompact 100000` so compaction becomes the automatic reset. Memory reloads after it.
- Set the curator model with `/plugin configure slate` (`curatorModel`, default `sonnet`), or in user settings: `"pluginConfigs": {"slate@slate-plugin": {"options": {"curatorModel": "haiku"}}}`.

## Layout

| In `~/slate/<name>/` | Holds |
|---|---|
| `instructions.md` | I items, shared by every session; always injected |
| `facts.md`, `assumptions.md` | key F and A items: what most sessions need on most turns; capped at 3,000 and 1,500 chars of items |
| `topics/<slug>.md` | every other F and A item, by topic: `# <Title>`, `> <summary>`, then items; listed in the memory block, read when a task needs them |
| `usage.json` | per F and A item: when the curator last marked it relevant, how often, and its home topic |
| `superseded.md` | retired items, append-only; never injected |
| `reports/` | details written by offload agents |
| `offloads.md` | one entry per offload run: its return, its session and the path to its transcript |
| `memory.lock` | held only while a curator applies changes |

| In `.sessions/<session_id>/` | Holds |
|---|---|
| `now.md` | goal, focus, open questions, next step (10 lines max) |
| `queue/` | `NNNN.md` per turn until curated |
| `handbacks/` | markers for offload hand-backs sent back for a rewrite |
| `session.json`, `curated.json` | process ID, turn counter, curation progress |
| `curator.log` | `ok`, `retry`, `partial`, `error`, `aborted`; `partial` and `error` also show as a warning |

## Hand edits

Edit memory files when no `memory.lock` exists; an edit during a run can be undone. A plain bullet without an ID is adopted with the next ID, text unchanged; in a topic file it becomes a fact.

## Cleanup

- At startup, session folders idle for 30 days with no live process are deleted.
- Slate's `done` skill deletes the whole slate.
- Old per-project `.slate/` folders are ignored. Delete them by hand. `node tools/migrate-session.mjs <oldSessionDir> <name>` copies one into a new slate and leaves the source untouched. It points `offloads.md`'s report paths at the slate's `reports/`.
- `node tools/reorganize-slate.mjs <name> [--dry-run]` sorts a slate's facts and assumptions into topic files with one curator-model run. It only regroups, gives each item left in a key file a home topic, and retires a status a later item replaces. It then checks that every item is still live or retired with a reason. `--dry-run` prints the plan, saves it (`--save <file>` picks where) and changes nothing; `--ops <file>` applies a saved plan without a model run.
- To reorganize with Codex, use `SLATE_RUNTIME=codex node tools/reorganize-slate.mjs <name> --dry-run`; it honors `SLATE_CODEX_MODEL` and `SLATE_CODEX_BIN` too.

## Permissions

In Claude Code, reads in the linked slate and writes under `reports/` are allowed without a prompt. Claude Code 2.1.308 has no Grep/Glob tool, so an agent that searches the slate with shell commands may get a prompt; adding `~/slate` to `permissions.additionalDirectories` in user settings avoids it. Codex uses the thread's normal sandbox permissions.

## Notes

- When `facts.md` or `assumptions.md` goes over its cap, the curator's apply step moves the least recently relevant items to their home topics (`general` if none) until it fits, and logs them as `demoted` in `curator.log`.
- `SLATE_HOME` (default `~/slate`) must be on a filesystem with hard links: locks are linked into place.
- Turn files escape exact marker lines with a leading backslash.
- The Claude curator finds `claude` through `CLAUDE_CODE_EXECPATH` and runs with `--setting-sources ""`: OAuth login works; `apiKeyHelper` auth can't reach it.
- Codex indexes subagent returns from linked threads in `offloads.md` and asks once for a shorter return above 800 characters. Its hooks do not grant tool permissions; shell reads and report writes follow the thread's sandbox and approval settings.
