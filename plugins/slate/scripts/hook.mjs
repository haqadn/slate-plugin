// Hook dispatcher for SessionStart, UserPromptSubmit, Stop and PreCompact.
// CLI: node hook.mjs <Event>, hook JSON on stdin, hook JSON (or nothing) on stdout. Always exits 0.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sessionDir, readSession, writeSession, findByPid, moveSession, copySession, setPid, claudePid,
  nextTurn, writeMessage, appendAnswer, appendContinuation,
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
    if (source !== 'clear' && source !== 'fork') return { output: null };
    const pid = currentPid(env);
    if (!pid) return { output: null };
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
    // A --resume runs in a new process; a later /clear finds the folder by this pid.
    const pid = currentPid(env);
    if (pid) await setPid(dir, pid);
  }
  await waitFree(dir, curatorWaitMs(env, START_WAIT_MS));
  return { output: context('SessionStart', await memoryBlock(dir, { afterCompact: source === 'compact' })) };
}

async function userPromptSubmit(input, dir, env) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt.startsWith('/slate:')) {
    await setKind(dir, 'slate');
    return { output: null };
  }
  if (prompt.startsWith('<task-notification>')) {
    // A background agent finished; its answer continues the current turn. Don't wait, but don't
    // diff memory a running curator may still restore either.
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

export async function handle(event, input, env = process.env) {
  if (env.SLATE_CURATOR === '1') return { output: null };
  if (!input || typeof input !== 'object' || input.agent_id) return { output: null };
  const root = env.CLAUDE_PROJECT_DIR || input.cwd;
  const id = input.session_id;
  if (!root || typeof id !== 'string' || !SAFE_ID.test(id)) return { output: null };
  const dir = sessionDir(root, id);

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
