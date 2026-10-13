# slate

A Claude Code plugin that keeps the main thread small. Heavy work goes to the `slate:offload` agent. Instructions, facts and focus live in curated per-session files that survive `/clear` and compaction.

## Install

```
claude plugin marketplace add ~/Projects/slate-plugin
claude plugin install slate@slate-plugin
```

## Use

- Run `/slate:init` in a session to turn slate on for that session only.
- Run `/autocompact 100000` so compaction becomes the automatic reset. Memory reloads after it.
- Set the curator model with `/plugin configure slate` (`curatorModel`, default `sonnet`), or in user settings: `"pluginConfigs": {"slate@slate-plugin": {"options": {"curatorModel": "haiku"}}}`.

## Layout

`.slate/` sits in the project and ignores itself in git.

| Path (in `.slate/<session_id>/`) | Holds |
|---|---|
| `instructions.md` | I items: standing rules from you |
| `assumptions.md` | A items: unverified guesses |
| `facts.md` | F items: verified, each with a source |
| `now.md` | goal, focus, open questions, next step (10 lines max) |
| `superseded.md` | retired items, append-only; never injected |
| `queue/` | `NNNN.md` per turn: your message and the answer, until curated (the newest stays until the next turn) |
| `reports/` | details written by offload agents |
| `handbacks/` | one marker per offload agent whose hand-back was sent back for a rewrite |
| `session.json` | process ID, turn counter, IDs last shown |
| `curated.json` | last curated turn and its file size, plus a turn to retry after an error (curator queue mark) |
| `curator.log` | curator results: `ok`, `retry` (edit rejected, trying again), `restored`, `error`, `aborted`; `restored` and `error` also show as a warning |

## Notes

- Edit memory files when no `curator.lock` exists — an edit during a curator run can be undone. A plain bullet without an ID is adopted with the next ID, text unchanged.
- Turn files escape exact marker lines with a leading backslash.
- The curator finds `claude` through `CLAUDE_CODE_EXECPATH`.
- The curator runs with `--setting-sources ""`, so it skips your settings files. OAuth login works; `apiKeyHelper`-based auth can't reach it.
- To turn slate off, delete the session folder.
