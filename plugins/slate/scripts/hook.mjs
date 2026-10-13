// Hook dispatcher for SessionStart, UserPromptSubmit, Stop, PreCompact, SubagentStop and PreToolUse.
// CLI: node hook.mjs <Event>, hook JSON on stdin, hook JSON (or nothing) on stdout. Always exits 0.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sessionDir, readSession, writeSession, findByPid, moveSession, copySession, setPid, releasePid, claudePid,
  nextTurn, writeMessage, appendAnswer, appendContinuation, pendingTurns,
} from './lib/session.mjs';
import { waitFree, lockHolder } from './lib/lock.mjs';
import { memoryBlock, changeLine } from './lib/inject.mjs';

const CURATE = fileURLToPath(new URL('./curate.mjs', import.meta.url));
const START_WAIT_MS = 20000; // SessionStart, and clear before aborting a curator
const FORK_WAIT_MS = 5000; // fork before aborting a curator
const ABORT_WAIT_MS = 5000; // for an aborted curator to undo its edit and release
const PROMPT_WAIT_MS = 20000;
const COMPACT_WAIT_MS = 60000;
const MAX_WAIT_MS = 25000;
// A session ID becomes a folder name; anything that could leave .slate/ is not ours.
const SAFE_ID = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
// Prompts the harness injects (a background agent finishing, a subagent hand-back, messages from
// other sessions or teammates, system notices). They continue the current turn; they are never
// the user's words.
export const HARNESS_PREFIXES = [
  '<task-notification', '<agent-message', '<cross-session-message', '<teammate-message', '[SYSTEM NOTIFICATION',
];
const isHarness = (prompt) => HARNESS_PREFIXES.some((p) => prompt.startsWith(p));
// Tools a subagent can return through instead of a final text answer; hooks.json matches these.
export const HANDBACK_TOOLS = ['SubagentHandback'];
const OFFLOAD_AGENT = 'slate:offload';
const RETURN_LIMIT = 800; // chars; above this an offload return is sent back once for a rewrite

const exists = (p) => fs.access(p).then(() => true, () => false);
const hasFolder = (dir) => exists(path.join(dir, 'session.json'));

// How long to wait for a running curator: `fallback`, or SLATE_WAIT_MS (for tests), at most 25s.
export function curatorWaitMs(env, fallback) {
  const n = Number(env.SLATE_WAIT_MS);
  return env.SLATE_WAIT_MS && Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_WAIT_MS) : fallback;
}

function isCurator(pid) {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).includes('curate.mjs');
  } catch {
    return false;
  }
}

// Before a folder is moved or copied, its curator must be gone: once the folder moves, the
// curator's restore and log would target the old path and an unchecked edit would be kept.
// Wait; then SIGTERM the holder if it is a curator (it undoes its edit and releases); wait again.
async function settle(dir, waitMs) {
  if (await waitFree(dir, waitMs)) return;
  const pid = await lockHolder(dir);
  if (pid && isCurator(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await waitFree(dir, ABORT_WAIT_MS);
}

// CLAUDE_PID from the given env, else claudePid()'s own lookup (process env, then the ancestors).
function currentPid(env) {
  const n = Number(env.CLAUDE_PID);
  return Number.isInteger(n) && n > 0 ? n : claudePid();
}

const context = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

async function setKind(dir, kind) {
  const s = await readSession(dir);
  s.lastKind = kind;
  await writeSession(dir, s);
}

async function sessionStart(input, root, dir, env) {
  const source = input.source;
  if (!(await hasFolder(dir))) {
    const pid = currentPid(env);
    if (!pid) return { output: null };
    // This process now runs a session without a folder: no folder may keep its pid.
    if (source === 'startup' || source === 'resume') await releasePid(root, pid);
    if (source !== 'clear' && source !== 'fork') return { output: null };
    const found = await findByPid(root, pid);
    if (!found || found === dir) return { output: null };
    if (source === 'clear') {
      await settle(found, curatorWaitMs(env, START_WAIT_MS));
      await moveSession(found, dir);
    } else {
      await settle(found, curatorWaitMs(env, FORK_WAIT_MS));
      await copySession(found, dir, pid);
    }
  } else if (source === 'resume') {
    // A --resume runs in a new process; a later /clear finds the folder by this pid. An in-process
    // /resume keeps the pid, which another folder may still hold: only this one keeps it.
    const pid = currentPid(env);
    if (pid) {
      await setPid(dir, pid);
      await releasePid(root, pid, dir);
    }
  }
  const free = await waitFree(dir, curatorWaitMs(env, START_WAIT_MS));
  const output = context('SessionStart', await memoryBlock(dir, { afterCompact: source === 'compact', waiting: !free }));
  // Turns left uncurated, e.g. by a curator aborted above before the move or copy: drain them now
  // rather than at the next Stop. Only after the block, so it never reads a curator's unchecked
  // edit; and only when the lock is free, since a holder rechecks the queue after its release.
  const pending = free ? await pendingTurns(dir) : null;
  return pending ? { output, spawned: spawnCurator(dir, pending.to, env) } : { output };
}

async function userPromptSubmit(input, dir, env) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt.startsWith('/slate:')) {
    await setKind(dir, 'slate');
    return { output: null };
  }
  if (isHarness(prompt)) {
    // E.g. a background agent finished; the answer that follows continues the current turn. Don't
    // wait, but don't diff memory a running curator may still restore either.
    await setKind(dir, 'notification');
    const waiting = !(await waitFree(dir, 0));
    return { output: context('UserPromptSubmit', await changeLine(dir, { waiting })) };
  }
  const waiting = !(await waitFree(dir, curatorWaitMs(env, PROMPT_WAIT_MS)));
  const turn = await nextTurn(dir, { lastKind: 'user' });
  await writeMessage(dir, turn, prompt, new Date().toISOString());
  return { output: context('UserPromptSubmit', await changeLine(dir, { waiting })) };
}

function spawnCurator(dir, turn, env) {
  const model = env.CLAUDE_PLUGIN_OPTION_CURATORMODEL || 'sonnet';
  const args = [CURATE, dir, String(turn), model];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
  child.on('error', (e) => process.stderr.write(`slate: curator spawn failed: ${e.message}\n`));
  child.unref();
  return args;
}

async function stop(input, dir, env) {
  const s = await readSession(dir);
  const answer = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (s.turn < 1) return { output: null };
  if (s.lastKind === 'user') await appendAnswer(dir, s.turn, answer);
  else if (s.lastKind === 'notification') await appendContinuation(dir, s.turn, answer);
  else return { output: null };
  return { output: null, spawned: spawnCurator(dir, s.turn, env) };
}

// An offload agent's return goes into the main thread. Over the limit, send it back once for a
// shorter rewrite; the second stop carries stop_hook_active and always passes.
function subagentStop(input) {
  const text = input.last_assistant_message;
  if (input.agent_type !== OFFLOAD_AGENT || input.stop_hook_active === true || typeof text !== 'string') {
    return { output: null };
  }
  const chars = [...text].length;
  if (chars <= RETURN_LIMIT) return { output: null };
  return {
    output: {
      decision: 'block',
      reason: `Return is ${chars} chars. Rewrite it in ≤600 chars, ≤10 lines; details belong in the report.`,
    },
  };
}

// The same cap for an offload agent that returns through a hand-back tool (its SubagentStop then
// has no last_assistant_message). The first message over the limit is denied; the marker
// handbacks/<agent_id> makes the agent's next hand-back go through, whatever its length.
async function preToolUse(input, dir) {
  const text = input.tool_input?.message;
  const agent = input.agent_id;
  if (input.agent_type !== OFFLOAD_AGENT || !HANDBACK_TOOLS.includes(input.tool_name) || typeof text !== 'string') {
    return { output: null };
  }
  const chars = [...text].length;
  if (chars <= RETURN_LIMIT || typeof agent !== 'string' || !SAFE_ID.test(agent)) return { output: null };
  try {
    await fs.mkdir(path.join(dir, 'handbacks'), { recursive: true });
    await fs.writeFile(path.join(dir, 'handbacks', agent), '', { flag: 'wx' });
  } catch {
    return { output: null }; // already denied once (EEXIST), or the marker can't be written: allow
  }
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Hand-back is ${chars} chars. Call ${input.tool_name} again with ≤600 chars, ≤10 lines; details belong in the report.`,
      },
    },
  };
}

export async function handle(event, input, env = process.env) {
  if (env.SLATE_CURATOR === '1') return { output: null };
  if (!input || typeof input !== 'object') return { output: null };
  // SubagentStop and a subagent's PreToolUse carry its agent_id; any other event with one fired
  // inside a subagent.
  if (input.agent_id && event !== 'SubagentStop' && event !== 'PreToolUse') return { output: null };
  const root = env.CLAUDE_PROJECT_DIR || input.cwd;
  const id = input.session_id;
  if (!root || typeof id !== 'string' || !SAFE_ID.test(id)) return { output: null };
  const dir = sessionDir(root, id);

  if (event === 'SubagentStop') return (await hasFolder(dir)) ? subagentStop(input) : { output: null };
  if (event === 'PreToolUse') return (await hasFolder(dir)) ? preToolUse(input, dir) : { output: null };
  if (event === 'SessionStart') return sessionStart(input, root, dir, env);
  if (!(await hasFolder(dir))) return { output: null };
  switch (event) {
    case 'UserPromptSubmit':
      return userPromptSubmit(input, dir, env);
    case 'Stop':
      return stop(input, dir, env);
    case 'PreCompact':
      await waitFree(dir, COMPACT_WAIT_MS);
      return { output: null };
    default:
      return { output: null };
  }
}

async function main(event) {
  try {
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    const { output } = await handle(event, JSON.parse(text), process.env);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (e) {
    process.stderr.write(`slate ${event} hook: ${String(e?.message ?? e).replace(/\s+/g, ' ').trim()}\n`);
  }
  process.exitCode = 0;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) await main(process.argv[2]);
