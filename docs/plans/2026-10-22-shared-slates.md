# Shared slates — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move slate memory from one folder per session in the project to one shared folder per topic in `~/slate/<name>/`, safe for parallel sessions.

**Architecture:** The session folder `<slate>/.sessions/<id>/` stays the handle every function takes (`dir`). The slate folder is derived from it. Shared files (instructions, assumptions, facts, superseded, reports, offloads) resolve against the slate; `now.md` and bookkeeping resolve against the session. The curator stops editing files: it returns a JSON change list that `lib/apply.mjs` applies under a short `memory.lock`.

**Tech Stack:** Node ≥ 24, ESM `.mjs`, `node:test`, no dependencies.

**Spec:** `docs/specs/2026-10-22-shared-slates-design.md`. It amends `docs/specs/2026-10-07-slate-plugin-design.md` and `docs/specs/2026-10-13-offload-index-design.md`. Read all three. `docs/verified.md` has the platform facts (section 10 covers the permission hook).

**Level of detail:** deliverables, interfaces, test cases and acceptance checks. Code inside a function is the implementer's call.

## Global Constraints

- **Work only in this worktree** (`.worktrees/shared-slates`). The main checkout's `plugins/slate` is the installed plugin: live sessions run its hook scripts from disk.
- Slate root: `process.env.SLATE_HOME || path.join(os.homedir(), 'slate')`. Every test sets `SLATE_HOME` to a temp dir. No test touches `~/slate`.
- Slate names match `/^[a-z0-9]+(-[a-z0-9]+)*$/`, at most 64 chars.
- Nothing is written into project folders. Old `<project>/.slate/` folders are never read or written.
- Hooks never exit 2. Every hook does nothing in an unlinked session, or with `SLATE_CURATOR=1`.
- Item tags: `- [I12 t3@82b3114c] text`, where `t3` is the session's turn and `82b3114c` is the first 8 chars of the session ID. Retired: `- [I12 t3@82b3114c retired t5@9f0e1a2b] text (reason: why)`. Old tags without `@…` (`[I12 t3]`, `t0`, `retired t5`) must still parse. Adopted plain bullets get `t0`.
- Offload index header: `## t<turn>@<session8> <ISO time> <agent_id>`.
- `rules.md` placeholders: `{{slate}}` (slate folder) and `{{session}}` (session folder). Keep it ≤ 1,700 chars with 120-char paths substituted.
- Model calls only in Task 5 (live acceptance) and in probe steps named in a task.
- Test command: `npm test`. Commit after each task. End commit messages with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W9qX3Rfn19W5KZs9fnYc1U
  ```

## Review Focus

1. **Path spellings in the permission hook:** `/tmp/...` vs `/private/tmp/...`; a home dir reached through a symlink; `<slate>/reports/../../x`; a symlink inside `reports/` that points outside. Expected: allowed only when the real target is inside the slate (writes: inside `reports/`). Tests in Task 4.
2. **Two curators applying at the same instant, and a curator killed while holding `memory.lock`.** Expected: nothing lost, IDs unique, the dead holder's lock taken over. Tests in Task 2.
3. **Old-format data** (the jetpack-seo migration): `[I3 t12]` items, `retired t5` lines, old `## t12 <time> <agent>` offload headers, a `session.json` without new fields. Expected: parsed, injected and curated as normal. Tests in Tasks 1 and 2.
4. **`/slate:done` while a curator is mid-run** (this session's, or one from a session that already ended). Expected: the curator is aborted, the slate is gone, and nothing recreates files in it afterwards. The apply step never creates the slate folder. Test in Task 3.
5. **Bad names from the picker's free-text box:** `Jetpack SEO`, `../x`, empty, 200 chars. Expected: a one-line error naming the allowed form; nothing created. Test in Task 3.

---

### Task 1: Shared layout and session lookup

Everything that finds or reads a session moves to `~/slate/`. After this task, a session folder created with the helpers below works end to end with today's curator, which now edits the slate's shared files.

**Files:**
- Create: `plugins/slate/scripts/lib/slate.mjs`
- Modify: `plugins/slate/scripts/lib/session.mjs` (drop `projectDir`, `sessionDir`, `initSession`; lookups take `home`; `readMemory`, `writeMemory` and `appendOffload` resolve shared paths)
- Modify: `plugins/slate/scripts/hook.mjs` (`handle` finds the session with `findSession`; `clear` and `fork` target a sibling folder in the same `.sessions/`)
- Modify: `plugins/slate/scripts/lib/inject.mjs` (`rulesText`, `lagLine`, file pointers in `memoryBlock` and `changeLine`)
- Modify: `plugins/slate/scripts/curate.mjs` (memory paths from `memoryPath`; cwd = slate folder)
- Modify: `plugins/slate/rules.md`, `plugins/slate/agents/offload.md`
- Delete: `plugins/slate/skills/init/`, `plugins/slate/scripts/init.mjs`, `test/init.test.mjs`
- Test: `test/slate.test.mjs` (new), `test/session.test.mjs`, `test/hook.test.mjs`, `test/inject.test.mjs`, `test/curate.test.mjs`, `test/packaging.test.mjs`

**Interfaces (produces), in `lib/slate.mjs`:**
- `slateHome(env = process.env) → string`
- `validName(name) → boolean`
- `slateDir(home, name) → string` (`<home>/<name>`)
- `slateOf(sessionDir) → string` (`dirname(dirname(sessionDir))`)
- `memoryPath(sessionDir, file) → string`: `now.md` → the session folder; `instructions.md`, `assumptions.md`, `facts.md`, `superseded.md` → the slate folder. Throws for any other name.
- `createSlate(home, name) → Promise<{ created: boolean, dir: string }>`: makes the four shared files with today's titles, `reports/` and `.sessions/`. Throws on an invalid name.
- `createSession(slate, sessionId, pid) → Promise<{ created: boolean, dir: string }>`: makes `.sessions/<id>/` with `queue/`, an empty `now.md` and `session.json` (`{ pid, created, from: null, turn: 0, seen: {} }`).
- `listSlates(home) → Promise<Array<{ name, dir, lastUsed }>>`: most recently used first. `lastUsed` is the newest `session.json` mtime under its `.sessions/`, else the folder's mtime. Skips entries that aren't valid names.
- `sessionDirs(home) → Promise<string[]>`: every linked session folder in every slate. A detached folder (name contains `.detached-`) is excluded.
- `findSession(home, sessionId) → Promise<string | null>`

**Interfaces (changed), in `lib/session.mjs`:**
- `findByPid(home, pid)` and `releasePid(home, pid, keep)`: same behavior, over `sessionDirs(home)`.
- `readMemory(dir)` and `writeMemory(dir, files)`: same keys (the five file names), resolved with `memoryPath`.
- `appendOffload(dir, { turn, at, agentId, transcript, text })`: writes `<slate>/offloads.md` with the new header. The title is written with flag `wx`, then the entry appended, so two first entries can't both write it (follow-up #13).

**Rules text:** `rulesText(dir)` substitutes `{{slate}}` = `slateOf(dir)` and `{{session}}` = `dir`. The brief format becomes: read `{{slate}}/instructions.md`, `facts.md` and `{{session}}/now.md`; write details to `{{slate}}/reports/<slug>.md`, a slug no other report uses. `offload.md`: its description says use it when the brief gives `~/slate/` paths; it never overwrites an existing report.

- [ ] **Step 1: Failing tests**
  - `slateHome` honors `SLATE_HOME`, else `~/slate`.
  - `validName`: accepts `jetpack-seo`, `a1`. Rejects `Jetpack`, `jetpack seo`, `-x`, `x-`, `a--b`, `../x`, `''` and a 65-char name.
  - `createSlate` then `createSession`: the layout matches the spec; a second call returns `created: false`.
  - `memoryPath` maps `now.md` to the session and the other four to the slate, and throws on `session.json`.
  - `findSession` finds a session in either of two slates, returns null for an unknown ID, and ignores `<id>.detached-123`.
  - `findByPid` and `releasePid` work across two slates; the most recently written `session.json` wins on a shared pid.
  - `listSlates` orders by the newest session activity.
  - `appendOffload`: header `## t4@82b3114c …`; two concurrent first appends leave one title and two whole entries; an existing `offloads.md` with old headers is appended to unchanged.
  - Hooks (`handle` with `SLATE_HOME` set): an unlinked session gets no output for every event; a linked one records turns and injects. `clear` renames within `.sessions/`; `fork` copies within it; `resume` rewrites the pid. No hook writes anything under `input.cwd`.
  - `memoryBlock` and `changeLine` read shared items from the slate and `now.md` from the session. Two sessions on one slate: an item added to the shared file shows as `+I…` in each session's next change line, once.
  - `rules.md` with 120-char paths renders ≤ 1,700 chars, has no `{{`, and names both folders.
  - A session folder whose `session.json` lacks `seen` and `from` (migrated) still injects and records turns.
- [ ] **Step 2:** Run `npm test`; the new tests fail.
- [ ] **Step 3:** Implement. Update the existing tests that built `<root>/.slate/<id>` to build a slate under `SLATE_HOME` instead.
- [ ] **Step 4:** Run `npm test`; all pass.
- [ ] **Step 5:** Commit: `Shared slate layout and session lookup`.

---

### Task 2: Curator returns a change list

**Files:**
- Create: `plugins/slate/scripts/lib/apply.mjs`
- Modify: `plugins/slate/scripts/lib/items.mjs` (tag format), `plugins/slate/scripts/lib/lock.mjs` (lock name), `plugins/slate/scripts/curate.mjs`, `plugins/slate/curator-rules.md` (rewrite), `plugins/slate/scripts/lib/inject.mjs` (warning statuses), `test/fixtures/fake-claude.mjs`
- Delete: `plugins/slate/scripts/lib/check.mjs` and `test/check.test.mjs`, unless something else still needs them
- Test: `test/apply.test.mjs` (new), `test/items.test.mjs`, `test/lock.test.mjs`, `test/curate.test.mjs`, `test/inject.test.mjs`

**Interfaces:**
- Consumes: `memoryPath`, `slateOf`, `readMemory`, `atomicWrite` (Task 1).
- `parseItemLine(line) → { type, id, num, turn, session: string | null, text } | null` and `parseRetiredLine(line) → { …, retiredTurn, retiredSession: string | null, reason } | null`. `formatItem` and `formatRetired` write the new tag (Global Constraints).
- `acquire(dir, name = 'curator.lock')`, `waitFree(dir, ms, name = 'curator.lock')`, `lockHolder(dir, name = 'curator.lock')`.
- `CHANGE_SCHEMA`, exported from `apply.mjs`: `{ ops: Op[] }`, where each `Op` is one of:
  - `{ op: 'add', type: 'I'|'A'|'F', text }`
  - `{ op: 'retire', id, reason }`
  - `{ op: 'replace', id, text, reason }`
  - `{ op: 'now', text }`

  Use `oneOf` with `additionalProperties: false` per op. The probe showed the model adds an `id` to `add` when it's allowed to.
- `applyChanges(dir, ops, { turn, sessionId, lenient = false }) → Promise<{ applied: string[], skipped: string[], errors: string[] }>`:
  - Takes `memory.lock` in the slate (waits up to 10s; a dead holder's lock is taken over), rereads the files, applies, writes each changed file with `atomicWrite`, releases.
  - **Strict** (default): any error means nothing is applied.
  - **Lenient:** valid ops apply, invalid ones are dropped, and a stale `replace` applies its add half.
  - Always: plain user bullets in the three item files are adopted (`t0`, text unchanged), and an `add` whose text matches a live item exactly goes to `skipped`.
  - The new type's next ID is above every ID of that type in the four shared files, live or retired.
  - Never creates the slate folder: if it's gone, it throws.
  - Strings in `applied`, `skipped` and `errors` are safe tokens: op index, kind and ID, never item text.
- **Errors:** stale (the ID isn't live), unknown ID format, empty or multi-line text, text matching `RETIRED_LIKE`, an F item not ending in `(…)`, an F source containing `/reports/`, `.slate` or the slate path, an empty reason, `now` over 10 non-blank lines or containing an item tag.
- **Curator command:** `--tools Read`, with `Read(/<abs>)` allow rules for the five memory paths (realpath), `--json-schema <CHANGE_SCHEMA>` and `--output-format json`. Drop `Edit`/`Write`. Keep the other flags and the env from today. Parse the top-level `structured_output` (verified on 2.1.308; `result` holds the same object as a string).
- **`curateTurn` flow:**
  1. Attempt 1 applies strictly.
  2. On errors, log `retry` and run attempt 2 with the errors listed and "memory may have changed since your read; reread the files".
  3. Attempt 2 applies leniently.
  4. Log `ok` if nothing was dropped or forced, else `partial: <tokens>`.
  5. A run error or unparsable output is logged as `error` (queued once, as today). SIGTERM is logged as `aborted`.

  Snapshot, restore and `checkCuratorEdit` go away.
- **`changeLine` warnings:** surface `partial` and `error` (previously `restored` and `error`).
- **`curator-rules.md`:** keep "What goes where" (adjusted). Replace the editing rules with the operations and their constraints. Add: instructions are shared by every session; a standing rule tied to one task names the task in its text; a one-off request goes in `now`. The model never writes IDs for new items; it names existing IDs only to retire or replace them.

- [ ] **Step 1: Failing tests**
  - Items: the new tags round-trip; old `[I3 t12]`, `[I3 t0]` and `[I1 t1 retired t2] x (reason: y)` parse with `session: null`.
  - Apply: `add` gets the next ID and tag `t<turn>@<session8>`. `retire` moves the exact line to `superseded.md` with the retired tag and reason. `replace` does both. `now` rewrites only the session's `now.md`. Headings and untouched lines stay byte-identical.
  - Apply: plain bullets are adopted with `t0`; a duplicate add is skipped; strict with one stale ID applies nothing and reports `stale`; lenient with a stale `replace` applies the add; each validation error above is reported and, in lenient mode, dropped while the valid ops still apply.
  - Concurrency: two child processes each apply 20 adds to one slate at once. Afterwards there are 40 items with unique IDs and none lost.
  - Lock: a `memory.lock` holding a dead pid is taken over; a live holder makes `applyChanges` wait, then proceed.
  - Done slate: `applyChanges` on a session whose slate was deleted throws, and the folder is not recreated.
  - Curator (fake `claude` emitting `structured_output`, per `FAKE_MODE`): good → `ok`; invalid-then-good → `retry` then `ok`; invalid twice → `partial`, and the valid ops applied; stale → retry sees the other session's change; error and abort paths log and keep the turn queued as today; the args contain `--json-schema` and `--tools Read` and no `Edit`.
  - `changeLine` shows a `partial` warning once.
- [ ] **Step 2:** Run `npm test`; the new tests fail.
- [ ] **Step 3:** Implement. Rewrite `fake-claude.mjs` modes to print a `--output-format json` result object with `structured_output`.
- [ ] **Step 4:** Run `npm test`; all pass.
- [ ] **Step 5:** Commit: `Curator returns a change list; apply script owns memory writes`.

---

### Task 3: `/slate:link` and `/slate:done`

**Files:**
- Create: `plugins/slate/scripts/slate.mjs` (CLI), `plugins/slate/skills/link/SKILL.md`, `plugins/slate/skills/done/SKILL.md`
- Modify: `plugins/slate/scripts/hook.mjs` (export `settle` and `spawnCurator`, or move them to a lib, so `slate.mjs` can use them)
- Test: `test/cli.test.mjs` (new), `test/packaging.test.mjs`

**Interfaces:**
- Consumes: Task 1's `lib/slate.mjs`, `memoryBlock`, `rulesText`, `settle`, `spawnCurator`, `pendingTurns`.
- CLI `node slate.mjs <command> <sessionId> [name] [flags]`. The first stdout line is a status token, then free text:
  - `list <sid>` → `linked <name>` or `unlinked`; then one line per slate, most recent first; then `project: <cwd basename>`, plus `branch: <git branch>` when there is one.
  - `link <sid> <name> [--create]` → one of:
    - `linked`, `already-linked` or `switched`, each followed by the rules and the memory block
    - `confirm-create <name>`, plus ` closest <existing>` when an existing name is within edit distance 2, or one is a prefix of the other
    - `error <message>`
  - `done <sid> [name] --yes` → `deleted <name>`, `refused <name> live <session8,…>`, or `error <message>`. Without `--yes` it prints `error confirmation required`.
- **Switch:** settle the old session folder (wait or abort its curator), rename it to `<id>.detached-<epoch ms>`, set its pid to null, and spawn a drain on it if turns are pending. Then create the session in the new slate.
- **Live peer for done:** a linked session in that slate whose pid is alive (`process.kill(pid, 0)`), whose pid isn't this process's Claude pid, and whose ID isn't `sessionId`.
- **Done:** abort every curator in the slate (settle with 0 wait, then SIGTERM a `curate.mjs` holder), then `fs.rm(slate, { recursive: true })`.
- **Skills:** both `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`. Each body runs `` !`node "${CLAUDE_PLUGIN_ROOT}/scripts/slate.mjs" list "${CLAUDE_SESSION_ID}"` ``, then tells the model:
  - **link:** with `$ARGUMENTS`, run `link`. Without, ask with AskUserQuestion: up to three most recent slates, plus one name suggested from the conversation (or from project and branch). The free-text option takes a new name. On `confirm-create`, ask yes/no (naming the closest slate) and rerun with `--create`. Reply with one line, then follow the printed rules.
  - **done:** the name is `$ARGUMENTS`, or this session's slate. Ask yes/no with AskUserQuestion, naming the slate. Run `done … --yes`. Report the status line. On `refused`, name the live sessions.

- [ ] **Step 1: Failing tests** (CLI run as a child process with `SLATE_HOME` and `CLAUDE_PID` set)
  - `list`: ordering; `linked`/`unlinked`; the project line.
  - `link` to an existing slate → `linked`, rules and block printed, session folder created. A new name without `--create` → `confirm-create jetpack-seo closest jetpack-se0` and nothing created. With `--create` → created and linked. Again → `already-linked`, rules and block printed.
  - Switch: the old folder is renamed `.detached-…` with pid null, `findSession` returns the new one, and a pending turn in the old folder gets a drain spawned (seam: assert the spawn args).
  - Bad names (`Jetpack SEO`, `../x`, `''`, 200 chars) → `error …` naming the allowed form; nothing created under `SLATE_HOME`.
  - `done` without `--yes` → error. A live peer (a pid that's alive, e.g. the test runner's parent) → `refused`, slate intact. No peers → `deleted`, folder gone. A fake running curator holding a session lock is SIGTERMed before the delete.
  - Packaging: skills `link` and `done` exist with `disable-model-invocation: true`; `init` is gone.
- [ ] **Step 2:** Run `npm test`; the new tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`; all pass. Run `claude plugin validate plugins/slate`: no errors.
- [ ] **Step 5:** Commit: `/slate:link and /slate:done`.

---

### Task 4: Permission hook and session sweep

**Files:**
- Modify: `plugins/slate/hooks/hooks.json` (add a PreToolUse entry with matcher `Read|Write|Edit|Grep|Glob`; keep the `SubagentHandback` entry)
- Modify: `plugins/slate/scripts/hook.mjs` (PreToolUse dispatch; sweep on `startup`)
- Modify: `plugins/slate/scripts/lib/slate.mjs` (`slateAccess`, `sweepSessions`)
- Test: `test/hook.test.mjs`, `test/slate.test.mjs`

**Interfaces:**
- `slateAccess(toolName, toolInput, sessionDir) → 'allow' | null`:
  - Read: `file_path`. Grep and Glob: `path` (no `path` → null). Allowed when it's inside the slate.
  - Write and Edit: `file_path`, allowed when it's inside `<slate>/reports/`.
  - **Inside** means: after `path.resolve`, and after realpath of the deepest existing ancestor, it is under the slate's realpath or the slate's home-based path.
  - The hook outputs `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'slate folder' } }`. Otherwise no output, so normal permissions apply.
  - It runs for the main thread and subagents (input with `agent_id`).
- `sweepSessions(home, { now = Date.now(), maxIdleMs = 30 * 24 * 3600 * 1000, keep = null }) → Promise<string[]>`:
  - Deletes session folders, detached ones included, whose `session.json` mtime is older than `now - maxIdleMs` and whose pid is null or dead. Never deletes `keep`.
  - Returns the deleted paths.
  - Runs at SessionStart `startup`, whether or not the session is linked. It must stay cheap: readdir and stat only.

- [ ] **Step 1: Failing tests**
  - Read inside the slate → allow, for the main thread and for a subagent. Write to `reports/x.md` → allow. Write to `facts.md` → null. Read in another slate → null. An unlinked session → null for everything.
  - Path spellings (Review Focus 1): a `/private`-prefixed path and the symlinked form both allow; `reports/../../outside` → null; a symlink in `reports/` pointing outside → null for Read and Write; Grep without `path` → null.
  - The `SubagentHandback` cap still works through the same PreToolUse entry point.
  - Sweep: a 31-day-old folder with a dead pid is deleted; one with a live pid is kept; a 29-day-old one is kept; a detached old one is deleted; `keep` is kept.
- [ ] **Step 2:** Run `npm test`; the new tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`; all pass.
- [ ] **Step 5:** Commit: `Permission hook for the slate folder; sweep idle sessions`.

---

### Task 5: Live acceptance on shared slates

**Files:**
- Modify: `test/live/acceptance.mjs`
- Modify: `docs/acceptance.md` (results)

**What changes:**
- `SLATE_HOME` is a temp dir. The test pre-creates the slate `accept` with `createSlate`, so `/slate:link accept` links directly in `-p` mode (there's no AskUserQuestion there).
- Session A runs the existing script, adapted: `/slate:link accept`, "use npm", a heavy search, "switch to pnpm", "what installs lodash?".
- Session B runs in parallel: `/slate:link accept`, then three short turns timed to overlap with A's curators.
- The default permission mode for one run, without `acceptEdits`.

**Checks** (in addition to today's, adapted to the new paths):
1. After A's "use pnpm" turn is curated, B's next UserPromptSubmit output contains `+I` with `pnpm`.
2. Both sessions' curators ran at overlapping times (from `curator.log` timestamps). Afterwards every item either session added is present, and IDs are unique.
3. A's offload wrote `reports/<slug>.md` with no permission denial in the default permission mode, and B read it with no denial.
4. Nothing was written under either session's cwd.

- [ ] **Step 1:** Adapt the script. Run `npm test`: the live test stays skipped.
- [ ] **Step 2:** Run `node test/live/acceptance.mjs --live --out <scratch>/live.json`; all checks pass. On failure, fix the cause in the owning task's code with a test, and rerun.
- [ ] **Step 3:** Record the results in `docs/acceptance.md`.
- [ ] **Step 4:** Commit: `Live acceptance for shared slates`.

---

### Task 6: Migration tool and docs

**Files:**
- Create: `tools/migrate-session.mjs`, `test/migrate.test.mjs`
- Modify: `README.md`, `docs/specs/2026-10-07-slate-plugin-design.md` (add "Amended by" the shared-slates spec), `docs/follow-ups.md` (close #13; add anything new), `plugins/slate/.claude-plugin/plugin.json` (version `0.2.0`; description says shared topic slates)

**Interfaces:**
- `node tools/migrate-session.mjs <oldSessionDir> <name>`, honoring `SLATE_HOME`.
  - Refuses if the slate already exists, or if `<oldSessionDir>/curator.lock` is held by a live curator.
  - Copies `instructions.md`, `assumptions.md`, `facts.md`, `superseded.md`, `offloads.md` and `reports/` to the slate.
  - Copies `now.md`, `session.json`, `curated.json`, `curator.log`, `queue/` and `handbacks/` to `.sessions/<basename(oldSessionDir)>/`.
  - Skips `conversation/` and `curator.lock`. Never modifies or deletes the source.
  - Prints the item counts per file, source and target.

- [ ] **Step 1: Failing tests:** a fixture old folder migrates with byte-identical files in the right places; the source is unchanged; `findSession` finds the session; `memoryBlock` renders; a second run refuses.
- [ ] **Step 2:** Run `npm test`; the new tests fail.
- [ ] **Step 3:** Implement. Write the README (one screen):
  - install
  - `/slate:link` and `/slate:done`
  - `/autocompact 100000`
  - the layout table for slate and session
  - hand edits (edit when no `memory.lock` exists)
  - cleanup: the 30-day sweep, `/slate:done`, deleting old `.slate/` folders by hand
  - the curator model setting
- [ ] **Step 4:** Run `npm test`; all pass.
- [ ] **Step 5:** Commit: `Migration tool, README and docs for shared slates`.

The real migration of jetpack-seo runs after the branch is reviewed, from the controller session, not in this task.
