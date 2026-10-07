# slate plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin where `/slate:init` gives a session a curated `.slate/<session_id>/` memory. Hooks record each turn, a background curator maintains the memory, and an `offload` agent keeps heavy work out of the main thread.

**Architecture:**
- **Hooks:** one hook script, dispatched by event, handles SessionStart, UserPromptSubmit, Stop and PreCompact.
- **Curator:** a detached `claude -p` that edits the five memory files. A pure safety-check function then keeps or restores its edits.
- **Shared code:** everything sits in small `scripts/lib/*.mjs` modules with `node:test` tests.

**Tech Stack:** Node ≥ 24, plain ESM `.mjs`, `node:test`, no dependencies. Claude Code 2.1.292 plugin system.

**Spec:** `docs/specs/2026-10-07-slate-plugin-design.md`. Read it before any task.

**Level of detail:** this plan fixes deliverables, interfaces, test cases and acceptance checks. Code inside a function is the implementer's call.

## Global Constraints

- Node ≥ 24, ESM `.mjs`, no dependencies (runtime or dev). Tests: `node --test test/` from the repo root.
- **Layout:**
  - Plugin root: `plugins/slate/`.
  - Marketplace manifest: `.claude-plugin/marketplace.json` at the repo root.
  - Tests: `test/` at the repo root.
- **Session folder:**
  - `.slate/` sits at `$CLAUDE_PROJECT_DIR`, falling back to the hook input `cwd`.
  - Each session's folder is `.slate/<session_id>/`.
- **Line formats:**
  - Item: `- [I12 t3] text`.
  - Retired: `- [I1 t1 retired t2] text (reason: why)`.
  - Headings: only `^#{1,6}(\s|$)` counts as a heading.
- **The five memory files:** `instructions.md`, `assumptions.md`, `facts.md`, `now.md`, `superseded.md`. Only `/slate:init` (creating empty ones) and the curator write them.
- **Hook rules:**
  - Hooks never exit 2.
  - A hook exits 0 at once with no output when the session has no folder, or when `SLATE_CURATOR=1` is set.
  - Injected `additionalContext` is at most 10,000 chars.
  - No hook ever injects text from `superseded.md`.
- **Curator command:** `claude -p --model <curatorModel> --settings '{"disableAllHooks":true}' --strict-mcp-config --disable-slash-commands --no-session-persistence --tools Read,Edit,Write`, plus the path-scoped permissions from `docs/verified.md`.
  - Env: `SLATE_CURATOR=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
  - Default model: `sonnet`.
  - Binary: overridable with `SLATE_CLAUDE_BIN` (used by tests).
- Tests make no real model calls, except Task 1's probes and Task 8's live acceptance.
- **Commits:** every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KkeLiyPKr2fb774K2BCHgd
  ```

## Review Focus

Failure modes the spec implies but the core tests don't exercise, each with its owning test:

1. **A message arrives while the curator has run longer than 20s.** Expected: the hook continues, the change line says `memory still updating`, and the next message shows the delta. (Task 6)
2. **Two slate sessions in one project.** Expected: separate folders and locks, and `/clear` moves only the folder whose process ID matches. (Task 3)
3. **A memory file was hand-edited into a malformed line before the turn**, e.g. `- [I3] no turn`. Expected: the check treats it like a plain user bullet that must survive word for word, and doesn't blame the curator for breakage that was already there. (Task 2)
4. **A message or answer over 10k chars.** Expected: stored in full in `conversation/`. The injected change line and memory block are unaffected and stay under the cap. (Task 6)
5. **Curator binary missing, or not logged in.** Expected: one line in `curator.log` plus a warning on the next message, no crash, the lock released, and the Stop hook still returns at once. (Task 5)

---

### Task 1: Verify platform behavior (probe run)

**Files:**
- Create: `docs/verified.md`
- Probes run in a temp dir outside the repo and are not committed.

**Interfaces:**
- Produces: `docs/verified.md`. One section per question below, each with the probe command, the observed output (trimmed), and the **chosen mechanism** that later tasks must use.

The questions:
1. How `/slate:init` gets the session ID. Does skill content substitute `${CLAUDE_SESSION_ID}`? Does UserPromptSubmit fire for a `/plugin:skill` prompt, and what is `prompt` then?
2. How a hook finds the Claude Code process ID. Walk the ancestor chain with `ps -o ppid=,comm= -p <pid>`. Name the rule that picks the right ancestor, and confirm it is the same before and after `/clear` in an interactive session (drive it with a Python `pty` script).
3. What `SessionStart` input contains for `source: "fork"` (`claude -p --resume <id> --fork-session`). Can the parent session be identified?
4. Does a detached child (Node `spawn(…, { detached: true, stdio: 'ignore' }).unref()`) started from a Stop hook keep running after the hook returns and after `claude -p` exits?
5. Path-scoped permissions for the curator. Find the exact `--allowedTools` and `--permission-mode` that let `Edit`/`Write` touch only five absolute file paths. Prove an Edit inside is allowed and one outside is denied.
6. The plugin `userConfig` (or equivalent) schema for a `curatorModel` option, and the env var name hooks receive. Check with `claude plugin validate`.
7. Does `claude -p --resume <id>` keep `session_id`? Does `/clear` give a new one (interactive)?
8. Do a `--plugin-dir` plugin's hooks (SessionStart, UserPromptSubmit, Stop) fire in `claude -p` mode? What is the agent name to use for a plugin agent `agents/offload.md` (e.g. `slate:offload`)?

- [ ] **Step 1:** Build a throwaway probe plugin in a temp dir: hooks that dump their stdin JSON, env and process ancestry to files, plus a skill that echoes `${CLAUDE_SESSION_ID}`.
- [ ] **Step 2:** Run each probe with `--model haiku` where a model call is needed. For questions 2 and 7, use an interactive session driven by a Python `pty` script.
- [ ] **Step 3:** Write `docs/verified.md`. If a question can't be answered, say so, and choose the spec's fallback (for example: the UserPromptSubmit hook catches the `/slate:init` prompt; a fork without an identifiable parent does nothing).
- [ ] **Step 4:** Remove the probe dir, delete any `~/.claude/projects/*` folders the probes created (list them in the doc first), and commit `docs: verified platform behavior`.

### Task 2: Line format and safety check

**Files:**
- Create: `package.json` (`"type":"module"`, `"test":"node --test test/"`, `"engines":{"node":">=24"}`), `plugins/slate/scripts/lib/items.mjs`, `plugins/slate/scripts/lib/check.mjs`
- Test: `test/items.test.mjs`, `test/check.test.mjs`

**Interfaces:**
- Produces (`items.mjs`):
  ```js
  export const ITEM_FILES = { I: 'instructions.md', A: 'assumptions.md', F: 'facts.md' };
  export const MEMORY_FILES = ['instructions.md', 'assumptions.md', 'facts.md', 'now.md', 'superseded.md'];
  export function isHeading(line)               // /^#{1,6}(\s|$)/
  export function parseItemLine(line)           // → { id:'I12', type:'I', num:12, turn:3, text } | null
  export function formatItem({ id, turn, text })
  export function parseRetiredLine(line)        // → { id, type, num, turn, retiredTurn, text, reason } | null
  export function formatRetired(r)
  export function parseMemoryFile(text)         // → { items: Item[], retired: Retired[], plain: string[] }
  // plain = every non-blank, non-heading line that is neither an item nor a retired line, verbatim
  ```
- Produces (`check.mjs`):
  ```js
  // before/after: { [file in MEMORY_FILES]: string }, turn: number → string[] (empty = pass)
  export function checkCuratorEdit(before, after, turn)
  ```
  The rules are the spec's safety check 1–5. Each violation string names the ID or line.

- [ ] **Step 1: Write failing tests.**
  - Format round-trips for I, A, F and retired lines, including text containing `[`, `]`, `(`, `)` and unicode, and a reason containing parentheses.
  - `isHeading`: `# T` and `##` are headings; `#1 priority` and `#todo` are not.
  - `parseMemoryFile` sorts lines into items, retired lines and plain lines.
  - Check, passing cases: no change; add `I3 t5`; supersede `I1` correctly (moved to superseded with `retired t5` and a reason); move `F2` between files with the same text; adopt a plain bullet as `[I4 t0]` with identical text.
  - Check, failing cases, each with its own violation:
    - rewording a live item
    - deleting an item outright
    - a retired line missing its reason or with the wrong `retired tN`
    - removing a line from `superseded.md`
    - a new ID that isn't above the previous maximum, or is duplicated
    - a new item tagged with the wrong turn
    - a plain bullet that vanished or was reworded
    - `now.md` over 10 lines
  - **Review Focus 3:** `- [I3] no turn` already present before the turn is treated as a plain line. Leaving it as is passes. Removing it fails.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: line format and curator safety check`.

### Task 3: Session folder, turn files, lock

**Files:**
- Create: `plugins/slate/scripts/lib/session.mjs`, `plugins/slate/scripts/lib/lock.mjs`
- Test: `test/session.test.mjs`, `test/lock.test.mjs`

**Interfaces:**
- Consumes: `MEMORY_FILES` from `items.mjs`. Uses the process-ID and fork mechanisms from `docs/verified.md`.
- Produces (`session.mjs`):
  ```js
  export function projectDir(input)                  // process.env.CLAUDE_PROJECT_DIR || input.cwd
  export function sessionDir(root, sessionId)        // <root>/.slate/<sessionId>
  export async function initSession(root, sessionId, pid) // → { created: boolean, dir }; writes .slate/.gitignore ("*\n") only when .slate/ is new; creates the five files (instructions/assumptions/facts/superseded get "# <Title>\n"; now.md empty), conversation/, reports/, session.json
  export async function readSession(dir)             // → { pid, created, from, turn, seen } (seen: { [id]: text })
  export async function writeSession(dir, data)      // atomic (temp + rename)
  export async function findByPid(root, pid)         // → dir | null
  export async function moveSession(fromDir, toDir)  // rename; sets from = basename(fromDir)
  export async function copySession(fromDir, toDir, pid)
  export function claudePid()                        // the mechanism from docs/verified.md
  export async function nextTurn(dir)                // turn += 1 in session.json, returns it
  export async function writeMessage(dir, turn, message, at)  // conversation/NNNN.md with <!-- slate:message --> section
  export async function appendAnswer(dir, turn, answer)       // adds <!-- slate:answer --> section
  export async function readTurn(dir, turn)          // → { message, answer }
  export async function readMemory(dir)              // → { [file]: text } for MEMORY_FILES
  export async function writeMemory(dir, files)      // atomic per file
  ```
- Produces (`lock.mjs`):
  ```js
  export async function acquire(dir)        // → release() | null (held by a live pid). Takes over a dead-pid lock.
  export async function waitFree(dir, ms)   // → true if free within ms
  ```

- [ ] **Step 1: Write failing tests** (temp dirs, removed in `after`):
  - `initSession` creates the full layout. A second call returns `created: false` and changes nothing.
  - `.gitignore` is written only when `.slate/` is new, and isn't recreated after being deleted.
  - Turn files round-trip a message containing markdown headings and `<!-- slate:answer -->`-like text. A 20k message is stored in full.
  - `nextTurn` increments.
  - **Review Focus 2:** two session folders with pids 111 and 222. `findByPid(root, 222)` returns the second. `moveSession` moves only that one, and its `from` is recorded.
  - `copySession` leaves the source intact and records the new pid.
  - Lock: acquire, then a second acquire returns `null`; release frees it; a lock with dead pid `999999` is taken over; `waitFree` returns false after a timeout while held.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: session folder, turn files, lock`.

### Task 4: Rules and context injection

**Files:**
- Create: `plugins/slate/rules.md`, `plugins/slate/scripts/lib/inject.mjs`
- Test: `test/inject.test.mjs`

**Interfaces:**
- Consumes: `readSession`, `writeSession`, `readMemory`, `parseMemoryFile`.
- Produces:
  ```js
  export async function rulesText()                       // contents of plugins/slate/rules.md
  export async function memoryBlock(dir, { afterCompact }) // → string ≤ 10000; also sets session.seen to the live items shown
  export async function changeLine(dir, { waiting })       // → string; diff of live items vs session.seen, then updates seen
  ```
- `rules.md` carries the spec's main-thread rules verbatim in meaning. That covers: short colleague replies; when to offload and when to keep work in the main thread; the brief format with `.slate/<id>/` paths; memory files are read-only; memory overrides earlier conversation; `superseded.md` only for "why"; no notes in CLAUDE.md or AGENTS.md. A `{{dir}}` placeholder is filled with the session folder path.
- `memoryBlock` order:
  1. A heading (with "Memory below wins where it differs from the summary." when `afterCompact`).
  2. The rules.
  3. Instructions.
  4. Now.
  5. Facts.
  6. Assumptions.

  If the block would exceed 10,000 chars, facts and then assumptions are replaced by their file paths. If it is still over, instructions are cut with a pointer to the file.
- `changeLine` format: `slate: +I14 Use pnpm · retired I3 · +F2 tests use vitest (package.json)`, prefixed by a reminder (`slate: offload heavy reads to slate:offload; reply briefly.`).
  - Add `memory still updating` when `waiting` is set.
  - Add one line per new `curator.log` warning since the last call.
  - Retired items appear by ID only.

- [ ] **Step 1: Write failing tests:**
  - **Core guarantee:** a `superseded.md` line containing `ZZ-RETIRED-ZZ`. Neither `memoryBlock` nor `changeLine` output contains it.
  - A block with 30k chars of facts stays ≤10,000 and names `facts.md` by path.
  - `afterCompact` adds the "wins over the summary" line.
  - The change line after an add shows the full text. After a retire it shows the ID only. A second call with no change shows only the reminder.
  - New `curator.log` lines are shown once.
  - `rules.md` contains "lead with the answer", "offload", "read-only", "CLAUDE.md".
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: rules and context injection`.

### Task 5: Curator runner

**Files:**
- Create: `plugins/slate/curator-rules.md`, `plugins/slate/scripts/curate.mjs`, `test/fixtures/fake-claude.mjs` (executable)
- Test: `test/curate.test.mjs`

**Interfaces:**
- Consumes: `readMemory`, `writeMemory`, `readTurn`, `acquire`, `checkCuratorEdit`. Uses the permission syntax from `docs/verified.md`.
- Produces:
  ```js
  export async function runCurator({ dir, turn, model = 'sonnet', bin = process.env.SLATE_CLAUDE_BIN || 'claude' })
  // → { ok: boolean, attempts: 1|2, violations: string[] }
  ```
  - CLI: `node curate.mjs <dir> <turn> [model]` calls `runCurator`.
  - Sequence: acquire the lock, snapshot the five files, run, check. On failure, retry once with the violations appended to the prompt. If it fails again, restore the snapshot and log. Release the lock in `finally`.
- `curator-rules.md` holds the spec's curator rules: standing vs one-off, never reword, supersede format, current-rule-only wording, next IDs, facts need a source, adopt plain bullets with `t0`, `now.md` ≤10 lines, change nothing if nothing changed.
- The prompt contains the rules, the turn number, the message verbatim, the answer, and the absolute paths of the five files.
- `curator.log` lines: `<ISO> t<N> <ok|retry|restored|error>: <detail>`.
- `fake-claude.mjs` records its args and env to `$FAKE_RECORD`. Its behavior comes from `$FAKE_MODE`:
  - `good`: adds a valid I item.
  - `bad`: rewords I1.
  - `bad-then-good`.
  - `fail`: exits 1.
  - `sleep`: sleeps 3s, then good.

- [ ] **Step 1: Write failing tests:**
  - Args contain every flag in Global Constraints. Env has `SLATE_CURATOR=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `--model` defaults to `sonnet`.
  - `good` keeps the edit, logs `ok` and releases the lock.
  - `bad` restores the snapshot byte for byte and logs `restored` with the violation.
  - `bad-then-good` keeps the second attempt, and its prompt contains the first attempt's violations.
  - **Review Focus 5:** `fail`, or a bin path that doesn't exist, logs `error`, leaves the files unchanged, releases the lock and doesn't throw.
  - A second `runCurator` while one holds the lock returns without running.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: curator runner`.

### Task 6: Hook dispatcher

**Files:**
- Create: `plugins/slate/scripts/hook.mjs`, `plugins/slate/hooks/hooks.json`
- Test: `test/hook.test.mjs`

**Interfaces:**
- Consumes: all `lib/*`, and `runCurator` through a detached `node curate.mjs` spawn (the mechanism from `docs/verified.md`).
- Produces:
  - CLI: `node hook.mjs <SessionStart|UserPromptSubmit|Stop|PreCompact>`. It reads the hook JSON from stdin and writes hook JSON to stdout.
  - `export async function handle(event, input, env)` returns `{ output: object | null, spawned?: string[] }`. Tests call it directly.
- **SessionStart:**
  - `clear`: find the folder by Claude process ID and move it to the new ID.
  - `fork`: copy per `docs/verified.md`, or do nothing.
  - Then, if the session has a folder: `additionalContext = memoryBlock(dir, { afterCompact: source === 'compact' })`.
- **UserPromptSubmit:**
  - Handles the `/slate:init` prompt if `docs/verified.md` chose that route.
  - Otherwise, when the session has a folder: `waitFree` for 20s, then `nextTurn`, then `writeMessage`, then `additionalContext = changeLine(dir, { waiting })`.
- **Stop:** `appendAnswer(dir, turn, input.last_assistant_message)` (`turn` comes from `readSession`), then spawn `node curate.mjs <dir> <turn> <model>` detached and return. `model` is the `curatorModel` option, using the env var named in `docs/verified.md`, default `sonnet`.
- **PreCompact:** `waitFree(dir, 60000)`, then exit 0 with no output.
- **Every event:** a `SLATE_CURATOR=1` guard. Any thrown error → exit 0 plus one stderr line.
- `hooks.json`: the outer `"hooks"` wrapper. SessionStart matcher is `startup|resume|clear|compact|fork`. UserPromptSubmit timeout is 30. PreCompact timeout is 90. Commands use `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" <Event>`.

- [ ] **Step 1: Write failing tests** (fake stdin JSON, temp project dir, `SLATE_CLAUDE_BIN` = fake-claude):
  - No folder: every event gives `output: null`. With `SLATE_CURATOR=1`: `output: null`, even with a folder.
  - UserPromptSubmit writes `conversation/0001.md` with the exact prompt. Its output has `hookSpecificOutput.additionalContext` containing the change line.
  - **Review Focus 4:** a 15k prompt is stored in full, and the additionalContext stays ≤10,000 and doesn't contain the prompt.
  - **Review Focus 1:** with the lock held by a live pid and `waitFree` set to 200ms in tests, the output says `memory still updating`. A later call after a fake curator adds an item shows `+I…`.
  - Stop appends the answer, spawns the curator detached and returns within 1s while fake-claude is set to `sleep`. Afterwards `curator.log` gets `ok` (poll up to 10s).
  - SessionStart `clear` moves the folder found by pid (inject the pid via env for the test) and returns a memory block. `compact` returns the block with the summary line.
  - Running `node hook.mjs Stop` as a real process with stdin JSON exits 0.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: hook dispatcher`.

### Task 7: Plugin packaging (init skill, offload agent, manifests, README)

**Files:**
- Create:
  - `plugins/slate/.claude-plugin/plugin.json` (with the `curatorModel` option per `docs/verified.md`)
  - `.claude-plugin/marketplace.json` (`{"name":"slate-plugin","owner":{"name":"Adnan"},"plugins":[{"name":"slate","source":"./plugins/slate"}]}`)
  - `plugins/slate/skills/init/SKILL.md`
  - `plugins/slate/scripts/init.mjs`
  - `plugins/slate/agents/offload.md`
  - `README.md`
- Test: `test/init.test.mjs`, `test/packaging.test.mjs`

**Interfaces:**
- Consumes: `initSession`, `claudePid`, `rulesText`.
- **`init.mjs <sessionId>`** (or the hook route, per `docs/verified.md`): runs `initSession` and prints the rules with `{{dir}}` filled in. If the folder already exists, it prints "slate already active" plus the rules.
- **`SKILL.md`:** frontmatter name `init`, plus a description. The body runs the init script and tells Claude to follow the printed rules from now on.
- **`offload.md`:** frontmatter with a description saying when to use it (heavy reads, searches, logs, test output, research, multi-file review); tools inherit. The body:
  - Read the memory files named in the brief.
  - Do the task.
  - Write details to the given `reports/<slug>.md`.
  - Return ≤10 lines: outcome, report path, open questions.
  - Never edit memory files, CLAUDE.md or AGENTS.md.
- **README**, one screen:
  - what slate does
  - install (`claude plugin marketplace add`, `claude plugin install slate@slate-plugin`)
  - `/slate:init`
  - recommend `/autocompact 100000`
  - the layout table
  - hand edits are safe once the change line has shown
  - `.slate/` ignores itself in git
  - the `curatorModel` setting

- [ ] **Step 1: Write failing tests:**
  - `init.mjs` in a temp project creates the folder and prints the rules with the real path. A second run prints "already active".
  - Packaging: `plugin.json` and `marketplace.json` parse, and their names match. `hooks.json` has the wrapper and all four events. Every `${CLAUDE_PLUGIN_ROOT}` path in `hooks.json` exists.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS, and `claude plugin validate plugins/slate` plus `claude plugin validate .` are clean (paste the output into the report).
- [ ] **Step 5:** Commit `feat: plugin packaging, init skill, offload agent, README`.

### Task 8: Live acceptance

**Files:**
- Create: `test/live/acceptance.mjs` (opt-in, never run by `npm test`), `docs/acceptance.md` (results)

**Interfaces:**
- Consumes: the whole plugin through `claude -p --plugin-dir plugins/slate`.

- [ ] **Step 1: Write `acceptance.mjs`.**
  - Setup: a temp project dir with a fake repo of about 200 files for the heavy search. Use one session ID across turns (`--session-id <uuid>` on turn 1, `--resume <uuid>` after).
  - Turn 1: `/slate:init`.
  - Turn 2: `For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.`
  - Turn 3: `Find every file that mentions "TODO(perf)" and summarize the patterns.`
  - Turn 4: `Change of plan: this project uses pnpm now.`
  - Turn 5: `What command installs lodash? Reply with only the command.`
  - Wait for the curator after each turn (poll `curator.lock` absence, up to 180s). The main session uses the default model, and the curator uses its default, `sonnet`.
- [ ] **Step 2: Assertions** (read the main transcript JSONL from `~/.claude/projects/<slug>/<uuid>.jsonl`):
  - Turn 3 used an Agent tool call with the offload agent. No `tool_result` in the main thread is over 2,000 chars.
  - No Agent call input after turn 4 matches `/\bnpm\b/`.
  - Live memory files don't match `/\bnpm\b/`. `superseded.md` does.
  - The turn-5 answer contains `pnpm`.
  - `stg-7.internal` is in live memory.
  - `curator.log` has no `restored` or `error` lines (report them if present).
- [ ] **Step 3:** Run it. Write `docs/acceptance.md` with the pass/fail of each check, the turn-5 answer and the final memory files. Don't loosen assertions to pass.
- [ ] **Step 4: Manual check of `/clear` and compaction.** Drive an interactive session with a Python `pty` script:
  - init, then a message, then `/clear`.
  - Check that the folder moved, and that the new session's first message gets a change line.
  - Then `/compact`, and check that the memory block was injected (from the transcript attachment).
  - Record the results in `docs/acceptance.md`.
- [ ] **Step 5:** Remove the temp dirs and any `~/.claude/projects/*` folders the runs created (list them in the doc), then commit `test: live acceptance`.

---

## Definition of Done

Copied from the spec:
- `/slate:init` works in a session, and hooks do nothing in sessions without it.
- After each turn: the message and answer are saved, the curator runs in the background, and the safety check either keeps or restores.
- `/clear` moves the folder and reloads memory. Compaction reloads memory.
- Unit and hook tests pass. The live acceptance run passes all four checks. The manual `/clear` and compaction check is done.
- README and `claude plugin validate` are clean.
