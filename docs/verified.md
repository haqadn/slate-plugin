# Verified platform behavior

Probed on Claude Code **2.1.292**, macOS, 2026-10-07. Later tasks must use the **Chosen mechanism** lines.

## Probe setup

- `$P` was a fresh dir, `/private/var/folders/…/T/slateprobe.xGT66O`, deleted afterwards. `$D` = `$P/proj/.slate/sid1`.
- `claude` meant `$P/bin/claude`, a symlink to `~/.local/share/claude/versions/2.1.292`.
  - Every run used `env -i` (HOME, USER, PATH, TERM only) with cwd `$P/proj`, so the parent session's `CLAUDE_*` vars could not leak in.
  - Model calls used `--model haiku`. Runs used `--setting-sources project,local` to keep the user's own hooks out, except where noted.
- The probe plugin `slate` was loaded with `--plugin-dir $P/plugin`:
  - Hooks on SessionStart, UserPromptSubmit, Stop, SubagentStart, SubagentStop, PreCompact and SessionEnd ran `scripts/dump.mjs`. It saved the stdin JSON, the `CLAUDE_*` env and the `ps` ancestor chain to `$P/out/`.
  - The Stop hook also started `child.mjs` detached. The child logged, slept 30s, then logged again, recording which ancestors were still alive.
  - `skills/init/SKILL.md` contained `${CLAUDE_SESSION_ID}`, `${CLAUDE_PLUGIN_ROOT}` and `${user_config.curatorModel}`, plus a `!` command.
  - Also included: `agents/offload.md`, and `userConfig.curatorModel` in `plugin.json`.
- **Interactive run** (Q2, Q3, Q7): `pty_drive.py` used Python `pty.fork()` at 120×40 to spawn `claude --plugin-dir $P/plugin --model haiku --setting-sources project,local`.
  - It typed: `/slate:init`, `Reply with exactly: HI1`, `/clear`, `Reply with exactly: HI2`, `/branch`, `Reply with exactly: HI3`, `/exit`.
  - Before each next step it waited for that step's hook dump. Every step completed.

## 1. How `/slate:init` gets the session ID

**Probe**
- Print mode: `claude -p "/slate:init" --plugin-dir $P/plugin --model haiku --setting-sources project,local --output-format stream-json --verbose`
- Interactive: typed `/slate:init` in the pty run.
- The skill body:

```
SESSION_ID_SUBST=${CLAUDE_SESSION_ID}
PLUGIN_ROOT_SUBST=${CLAUDE_PLUGIN_ROOT}
USER_CONFIG_SUBST=${user_config.curatorModel}
BANG_OUTPUT: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/dump.mjs" skill-bang "${CLAUDE_SESSION_ID}"`
```

**Observed.** The skill text as recorded in the transcript:

```
SESSION_ID_SUBST=a8e9c986-5031-436e-9595-4dc68a3bea01
PLUGIN_ROOT_SUBST=/private/var/folders/…/slateprobe.xGT66O/plugin
USER_CONFIG_SUBST=${user_config.curatorModel}        <- no value saved, left as-is
BANG_OUTPUT: BANG_RAN pid=71747 arg=a8e9c986-5031-436e-9595-4dc68a3bea01
```

- The `!` command got the ID as an argument. Its env also had `CLAUDE_CODE_SESSION_ID=a8e9c986-…` and `CLAUDE_PID`.
- The `!` command ran **before** UserPromptSubmit: 40176 vs 40216 ms in print mode, 90450 vs 90550 ms interactive.
- UserPromptSubmit fired in both modes with `"prompt": "/slate:init"`.
- The model replied `SID=<that session's id>` in both modes.

**Chosen mechanism.** `skills/init/SKILL.md` runs the init script through `!` injection:

```
---
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" "${CLAUDE_SESSION_ID}"`
```

- `allowed-tools: Bash(node:*)` is **untested**: every probe had it, so it's unknown whether the `!` command runs without it. Keep it.
- The script's stdout (rules and folder path) becomes the skill text, with no model round trip.
- The script reads `CLAUDE_PID` from its env (see Q2).
- The UserPromptSubmit fallback is not needed.
- **Note:** UserPromptSubmit sees the `/slate:init` prompt after the folder already exists. Decide whether it counts as turn 1.

## 2. How a hook finds the Claude Code process ID

**Probe.** `dump.mjs` walked up from `process.pid` with `ps -o ppid= -p <pid>` and `ps -o comm= -p <pid>`. It ran in print mode and in the interactive pty run.

**Observed.** In every one of the 30 dumps with a chain, `CLAUDE_PID` equals the first ancestor that is not a shell. (The first print-mode run's chains were empty because of a bug in the probe; its `CLAUDE_PID` was still set.)

| Context | Chain (pid:comm) | `CLAUDE_PID` |
|---|---|---|
| Hook, interactive, before `/clear` | `84317:node ← 82990:claude ← 82985:Python` | 82990 |
| Hook, interactive, after `/clear` (SessionStart, HI2 Stop) | `84688:node ← 82990:claude` | 82990 |
| Hook, interactive, after `/branch` | `85229:node ← 82990:claude` | 82990 |
| Skill `!` command | `83970:node ← 83969:/bin/zsh ← 82990:claude` | 82990 |
| Hook, `claude -p` | `73540:node ← 73425:claude ← 73420:/bin/zsh` | 73425 |
| Bash tool in the session that ran this task (2.1.293 under cmux) | `node ← /bin/zsh ← 6612:claude bg-spare ← 6600:claude bg-pty-host ← 6577:/Users/…/.local/bin/claude` | 6612 |

- The `comm` value is just how the binary was launched: `claude`, a full path, or `claude bg-spare`.
- Several `claude` processes can be stacked in one chain.

**Chosen mechanism.** Read `process.env.CLAUDE_PID`. Claude Code sets it for hooks, skill `!` commands and the Bash tool.
- **Fallback:** start at `process.ppid`, skip shells (`sh`, `bash`, `zsh`, `dash`, `fish`, with or without a path or leading `-`), and take the first other process.
- Don't match on the name `claude`; the table shows why.
- The PID stays the same across `/clear` and `/branch`.
- A `--resume` in a new process gets a new PID (Q7), so SessionStart(`resume`) must write the current PID back into `session.json`. This is a spec change; see Q7.

## 3. `SessionStart` input for a fork

**Probe**
- Print mode: `claude -p "Reply with exactly: FORK_OK" --resume a8e9c986-… --fork-session --plugin-dir $P/plugin --model haiku --setting-sources project,local --output-format json`
- Interactive: `/branch` in the pty run.

**Observed.** Print-mode fork, SessionStart input:

```json
{"session_id":"5b712beb-…","transcript_path":"…/5b712beb-….jsonl","cwd":"…","hook_event_name":"SessionStart",
 "source":"fork","seconds_since_last_response":23,"context_tokens":29536,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.0591}
```

- No parent ID appears in the input or the env. `CLAUDE_PID` is a new process (75043).
- The transcript did not exist yet at SessionStart or UserPromptSubmit.
- At Stop, the transcript existed:
  - Every line carried only the new `sessionId`.
  - 35 message uuids were copied from the parent.
  - No fork or parent field.
- Interactive `/branch`:
  - SessionEnd `{"session_id":"d35ea1e3-…","reason":"resume"}`, then SessionStart `{"session_id":"679d8c28-…","source":"fork",…}`.
  - Both had `CLAUDE_PID=82990`, the same process as the parent.

**Chosen mechanism**
- On `fork`, look for the folder whose `session.json` PID equals `CLAUDE_PID`, the same rule as `clear`.
  - **Match** (in-process `/branch`): copy that folder to the new ID.
  - **No match** (`claude --resume … --fork-session`, a new process): do nothing. The user can run `/slate:init`.
- After a copy, two folders hold the same PID. When matching, pick the folder whose `session.json` was written most recently; hooks write it every turn.

## 4. Detached child from a Stop hook

**Probe.** The Stop hook ran `spawn(process.execPath, [child.mjs, …], { detached: true, stdio: 'ignore' }).unref()`, then exited. The child slept 30s and recorded whether the `CLAUDE_PID` process was still alive.

**Observed.** All 7 children ran the full 30s:

| Session | Hook took | Child ran | Parent PID at child start | Claude alive when child finished |
|---|---|---|---|---|
| `-p` resume (2 Stops) | 57–59 ms | 30.003 s | 1 | no (`claude -p` exited at 09064, child ended 36614 / 38709) |
| `-p` fork | 57 ms | 30.003 s | 1 | no |
| Interactive (4 Stops) | 59–63 ms | 30.002–30.005 s | 1 | no for 3 of 4: `/exit` closed the pty at 29080, and later children ended up to 53057 |

- Each child had its own process group (pgid equal to its own pid), so the pty's hangup on exit did not reach it.
- `claude -p` did not wait for the child.

**Chosen mechanism.** Start the curator with Node `spawn(process.execPath, [curate.mjs, …], { detached: true, stdio: 'ignore', env }).unref()`, then exit the hook.
- No `setsid` or `nohup`; macOS has no `setsid` binary.

## 5. Path-scoped permissions for the curator

**Probe.** Each run used cwd `$P/proj`, `SLATE_CURATOR=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`:

```
claude -p "<numbered edit steps>" --model haiku --settings '{"disableAllHooks":true}' --strict-mcp-config \
  --disable-slash-commands --no-session-persistence --tools Read,Edit,Write --permission-mode dontAsk \
  --allowedTools <rules> --output-format json < /dev/null
```

Run B and run C added `--setting-sources ""`. Run A loaded the user's settings.

**Observed.** Results are from the files on disk and `permission_denials`.

| Run | Rule | Tool → target | Result |
|---|---|---|---|
| B | `Edit(///private/…/instructions.md)` | Edit | allowed |
| B | `Edit(/private/…/assumptions.md)`: single slash | Edit | **denied** |
| B | `Write(///…/now.md)` only | Edit | **denied**, because a Write rule does not cover Edit |
| B | `Edit(///…/superseded.md)` only | Write | allowed, because an Edit rule covers Write |
| A | `Edit(//var/folders/…/assumptions.md)`: path through a symlink | Edit on the `/private/var/…` path | allowed |
| A | none; the user settings have a bare `"Write"` in `permissions.allow` | Write `outside.md`, Write `conversation/0001.md` | **allowed, so the scoping leaked** |
| C | `Edit(//private/…/<file>)` for each of the five files | Edit ×3, Write ×2 on the five | all allowed |
| C | none | Edit `session.json`, Write `outside.md`, Write `conversation/0001.md` | all denied, and all three are listed in `permission_denials` |

- With stdin left open, `-p` printed `Warning: no stdin data received in 3s` and waited 3s.
- Read needed no rule for files under cwd.

**Chosen mechanism**

Example for session folder `/Users/me/proj/.slate/<id>`:

```
claude -p "$CURATOR_PROMPT" --model <curatorModel> --setting-sources "" \
  --settings '{"disableAllHooks":true}' --strict-mcp-config --disable-slash-commands \
  --no-session-persistence --permission-mode dontAsk --tools Read,Edit,Write \
  --allowedTools "Edit(//Users/me/proj/.slate/<id>/instructions.md)" \
                 "Edit(//Users/me/proj/.slate/<id>/assumptions.md)" \
                 "Edit(//Users/me/proj/.slate/<id>/facts.md)" \
                 "Edit(//Users/me/proj/.slate/<id>/now.md)" \
                 "Edit(//Users/me/proj/.slate/<id>/superseded.md)"
```

- **Prompt placement:** pass the prompt as the first positional argument, directly after `-p`, before any variadic flag (`--tools`, `--allowedTools` take `<tools...>`).
  - Runs A, B and C all did this with a multi-line prompt, and it worked.
  - A prompt placed last, or after `--`, was not tested.
  - In Node, pass `['-p', prompt, '--model', model, …]` as the args array, with no shell.
- **Rule syntax:** each rule is `"Edit(/" + absolutePath + ")"`, where `absolutePath` starts with `/`, so the rule starts with `//`.
  - Example: `Edit(//Users/me/proj/.slate/<id>/instructions.md)`.
  - One `Edit(...)` rule allows both Edit and Write.
- **Build `absolutePath` from `fs.realpathSync(folder)`.** On macOS, `/var/...` is a symlink to `/private/var/...`.
  - Run A showed a `/var/...` rule matching a `/private/var/...` edit, but only that one direction was tested.
  - The realpath keeps the rules and the model's paths in agreement.
- **`--setting-sources ""` is required.** Without it, allow rules from user or project settings let the curator write anywhere.
- **Cost of `--setting-sources ""`:** it skips the user, project and local settings files, so any `env` and `apiKeyHelper` set there are dropped too.
  - `--settings` and managed settings still apply.
  - OAuth login still worked here.
  - Not probed with an `apiKeyHelper` setup.
- **Spawn with stdin ignored** (`stdio: 'ignore'` or `< /dev/null`) to avoid the 3s stall. Stdin is therefore not a way to pass the prompt.
- Run the curator with cwd set to the project dir.

## 6. Plugin `userConfig` for `curatorModel`

**Probe.** `claude plugin validate $P/plugin` against this `plugin.json` fragment:

```json
"userConfig": { "curatorModel": { "type": "string", "title": "Curator model",
  "description": "Model the background curator runs on", "default": "sonnet" } }
```

The value was set with `--settings '{"pluginConfigs":{"slate@inline":{"options":{"curatorModel":"haiku"}}}}'`. Hook env was dumped with and without that setting.

**Observed**
- Validate: `✔ Validation passed with warnings`; the only warning was the missing `author`.
- Negative checks:
  - Key `curator-model` → `Invalid key in record`.
  - `type:"text"` with no title or description → `expected one of "string"|"number"|"boolean"|"directory"|"file"`, plus `title` and `description` required.
- **No value saved:** no `CLAUDE_PLUGIN_OPTION_*` var at all. The default is not exported.
- **Value saved:** every hook had `CLAUDE_PLUGIN_OPTION_CURATORMODEL=haiku`. An exec-form hook `{"command":"node","args":[…,"${user_config.curatorModel}"]}` received `haiku` as an argument.
- **Shell-form `command` containing `${user_config.curatorModel}`:** the hook failed with "Stop hook error occurred". The 2.1.292 binary says to use exec form or read `$CLAUDE_PLUGIN_OPTION_<KEY>`.
- **Env var name:** the binary builds it as `"CLAUDE_PLUGIN_OPTION_" + key.replace(/[^A-Za-z0-9_]/g,"_").toUpperCase()`.
- **Plugin ID:** `slate@inline` under `--plugin-dir`. Per the binary's plugin@marketplace format it should be `slate@slate-plugin` when installed; that case was not probed.

**Chosen mechanism.** Declare the option as above. Scripts read `process.env.CLAUDE_PLUGIN_OPTION_CURATORMODEL || 'sonnet'`.
- Apply the default in code, because unset means absent.
- Never put `${user_config.*}` in a shell-form hook command.
- Users set the value with `/plugin configure slate` (from the binary's help text; not probed), or with `pluginConfigs["slate@slate-plugin"].options.curatorModel` in user settings.

## 7. Session ID on `--resume` and `/clear`

**Probe**
- Resume: `claude -p "<prompt>" --resume a8e9c986-… --plugin-dir $P/plugin --model haiku --setting-sources project,local --output-format stream-json --verbose`
- `/clear`: in the pty run.

**Observed**
- **Resume:** SessionStart `{"session_id":"a8e9c986-…","source":"resume"}`.
  - Every later hook and the result kept `a8e9c986-…`.
  - `CLAUDE_PID` changed: 73425, versus 71226 when the session started.
- **`/clear`:** SessionEnd `{"session_id":"61939fdf-…","reason":"clear"}`, then SessionStart `{"session_id":"d35ea1e3-…","source":"clear"}`.
  - The next UserPromptSubmit and Stop used `d35ea1e3-…`.
  - `CLAUDE_PID` stayed 82990.

**Chosen mechanism**
- **`clear`, as in the spec:** new ID. Find the folder by `CLAUDE_PID` and rename it.
- **`resume`: spec change.** The ID is the same, so the folder exists. But a `--resume` in a new process has a new PID, so SessionStart(`resume`) must also rewrite `session.json`'s pid to the current `CLAUDE_PID`. Otherwise a later `/clear` finds no folder.
- **`compact`:** a rewrite is not needed. Compaction runs inside the same process, so the PID cannot change. Compaction was not probed; a rewrite would be harmless.

## 8. `--plugin-dir` hooks in `-p` mode, and the agent name

**Probe.** The print-mode runs above. Run 2 asked the model to call the Agent tool with `subagent_type "slate:offload"`.

**Observed**
- In `-p` mode, SessionStart, UserPromptSubmit, Stop, SubagentStart, SubagentStop and SessionEnd all fired from the `--plugin-dir` plugin.
- The stream-json init listed `agents: [..., "slate:offload", ...]`, `skills: ["slate:init"]`, and plugin `source: "slate@inline"`.
- SubagentStart and SubagentStop had `agent_type: "slate:offload"`. SubagentStop had `last_assistant_message: "OFFLOAD_OK"`.
- With `--settings '{"disableAllHooks":true}' --setting-sources ""` plus `--plugin-dir`, no hook fired.

**Chosen mechanism.** Use `hooks/hooks.json` as planned. Name the agent `slate:offload` in rules and briefs.

## 9. How a subagent's return reaches the hooks (SubagentStop, hand-back)

**Probe.** Claude Code 2.1.293 ran one `-p` offload under the user's real settings, with `--plugin-dir plugins/slate` and a recorder plugin added through a second `--plugin-dir`. The recorder had PreToolUse with no matcher, and SubagentStop. It saved each input's field names, `tool_name`, the `tool_input` keys, `agent_type`, `agent_id` and the message length. It printed nothing, so it couldn't affect any decision. The isolated runs of `test/live/acceptance.mjs` used the same recorder.

**Observed: SubagentStop, when the agent ends with a text answer (isolated runs)**
- Input keys:

  ```
  agent_id, agent_transcript_path, agent_type, background_tasks, cwd, effort, hook_event_name,
  last_assistant_message, permission_mode, prompt_id, session_crons, session_id, stop_hook_active, transcript_path
  ```

- `session_id` is the main session's ID. `agent_type` is `slate:offload`.
- The binary matches a SubagentStop matcher against `agent_type`.
- A `{"decision":"block","reason":…}` output makes the agent continue.
  - The reason is saved in the agent's transcript as a `Stop hook feedback:` message and one `hook_blocking_error` attachment.
  - The next stop has `stop_hook_active: true`.

**Observed: the hand-back tool (real settings)**
- Inside the subagent, PreToolUse fired for `tool_name: "SubagentHandback"`, with these keys:

  ```
  agent_id, agent_type, cwd, effort, hook_event_name, permission_mode, prompt_id, session_id,
  tool_input, tool_name, tool_use_id, transcript_path
  ```

  `agent_type` was `"slate:offload"`. `tool_input` has one key, `message`, which in that run was 507 chars.
- The SubagentStop that followed had **no `last_assistant_message`**. The agent's return was the hand-back message.
- In the main thread, that message arrives as a user message starting `<agent-message from="<agent_id>">`. The hook prompt and `conversation/` see it starting `<agent-message`. The transcript adds the intro line `Another Claude session sent a message:`.
- Under `--setting-sources project,local`, agents never used the hand-back. They ended with a text answer, which arrived as a `<task-notification>`.

**Chosen mechanism.** The return cap is best-effort, on two channels:
- **SubagentStop** with matcher `slate:offload` checks the final text.
- **PreToolUse** with matcher `SubagentHandback` checks `tool_input.message`. It denies the first message over the limit and lets the second through. A marker file `<dir>/handbacks/<agent_id>` records that the agent was already denied once.
- Any other return channel relies on the instruction in `offload.md`.

## 10. Offload transcripts (Claude Code 2.1.293)

**Probe.** The live acceptance runs of 2026-10-13 (`docs/acceptance.md`), plus one follow-up turn asking `slate:offload` to read a past run's transcript.

**Observed**
- SubagentStop carries `agent_transcript_path` for background agents and after a hand-back. It points to `~/.claude/projects/<slug>/<session>/subagents/agent-<agent_id>.jsonl`, and the file exists after the run.
- An offload agent can Read that path, even though it sits outside the project. A whole transcript can exceed Read's 25,000-token limit, so the agent needs offset and limit, or Grep.
- Bash is not auto-approved under `acceptEdits`, so a `grep` through Bash is denied.

**Chosen mechanism.** `offloads.md` stores the pointer. `offload.md` tells the agent to search a transcript with Grep, or Read with offset and limit, rather than read it whole.

## Other findings for later tasks

- **Background subagents.** In `-p` mode the Agent tool ran `slate:offload` in the background. Three hooks fired in sequence:
  1. Stop, with an interim `last_assistant_message` ("…running in the background…") and `background_tasks:[{status:"running"}]`.
  2. UserPromptSubmit, with `prompt` starting `<task-notification>`.
  3. A second Stop, with the real answer.

  Hooks must not count task notifications as user turns.
- **Internal agents.** SubagentStop also fires for internal agents, with `agent_type: ""`.
- **Transcript timing.** The transcript may not exist yet at SessionStart or the first UserPromptSubmit. Use `prompt` and `last_assistant_message`.
- **Extra input fields.** All hooks also get `prompt_id` and `permission_mode`. Stop adds `stop_hook_active` and `background_tasks`. SessionStart may add `model`, `scratchpad_dir` and `session_title`.
- **Plugin env.** Plugin hooks also get `CLAUDE_PLUGIN_DATA`, which was `~/.claude/plugins/data/slate-inline` under `--plugin-dir`.
- **No persistence.** `--no-session-persistence` wrote no transcript.

## Cleanup

This `~/.claude/projects` folder was created by the probes and has been removed:

- `~/.claude/projects/-private-var-folders-yn-n1h-qdds3g57ndq635ryl38w0000gn-T-slateprobe-xGT66O-proj`

Also removed: `/private/tmp/claude-501/-private-var-folders-yn-n1h-qdds3g57ndq635ryl38w0000gn-T-slateprobe-xGT66O-proj` (scratchpad and task output) and `$P`.

**Not removed.** These were created by the probes, but their names don't contain the temp path, so the cleanup ruling didn't cover them. They are harmless; delete them by hand if wanted:

- Empty dirs, one per probe session: `~/.claude/session-env/a8e9c986-5031-436e-9595-4dc68a3bea01`, `…/5b712beb-b3d8-41b1-84ae-805e27079c2d`, `…/61939fdf-1c38-4022-8355-7b1360fc9fb1`, `…/d35ea1e3-7b26-4ed0-886a-0a8ade1c8104`.
- The empty dir `~/.claude/plugins/data/slate-inline`. This is `CLAUDE_PLUGIN_DATA` for `--plugin-dir`, and development will reuse it.
- The project entry for `…/slateprobe.xGT66O/proj` in `~/.claude.json`. It was left alone rather than edit that file.
