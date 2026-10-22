// Curator runner: a fresh, read-only `claude -p` reads memory and returns a change list, which
// applyChanges (lib/apply.mjs) applies. Errors go back to the model once; the retry's valid ops
// apply and the rest are dropped with a `partial` warning.
// CLI: node curate.mjs <dir> <turn> [model]. It drains every pending turn of the session; <turn> is
// advisory. SIGTERM aborts: nothing from the running turn is applied and that turn stays queued.
import fs from 'node:fs/promises';
import { realpathSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readTurn, readSession, readCurated, turnState, atomicWrite, queueFile, sweepQueue,
} from './lib/session.mjs';
import { acquire } from './lib/lock.mjs';
import { applyChanges, CHANGE_SCHEMA } from './lib/apply.mjs';
import { MEMORY_FILES } from './lib/items.mjs';
import { memoryPath, slateOf, listTopics } from './lib/slate.mjs';

const RULES_FILE = new URL('../curator-rules.md', import.meta.url);
const ANSWER_MAX = 12000;
const MESSAGE_MAX = 100_000; // keeps argv well under ARG_MAX (E2BIG)
const TIMEOUT_MS = 300_000;
const STDERR_MAX = 300;
const STDOUT_MAX = 1_000_000;
const STDERR_GRACE_MS = 500;
const MAX_ATTEMPTS = 2;
const NO_ANSWER = '[no answer: turn was interrupted]';
const ABORTED = 'aborted';

// Parent-session identity and plumbing that must not leak into the curator's `claude -p`.
export const CURATOR_ENV_DENY = [
  // session identity
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_CODE_SESSION_LOG', 'CLAUDE_CODE_SESSION_ATTENDED',
  // messaging and jobs
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_JOB_DIR',
  // runtime
  'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_ENV_FILE', 'CLAUDE_EFFORT',
];

export function curatorEnv(env) {
  const out = { ...env };
  for (const k of CURATOR_ENV_DENY) delete out[k];
  out.SLATE_CURATOR = '1';
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return out;
}

// SLATE_CLAUDE_BIN, else the Claude Code executable that ran the hook (CLAUDE_CODE_EXECPATH, if it
// is an absolute path to an executable file), else `claude` on PATH, which may be a wrapper shim.
export function resolveClaudeBin(env = process.env) {
  if (env.SLATE_CLAUDE_BIN) return env.SLATE_CLAUDE_BIN;
  const exec = env.CLAUDE_CODE_EXECPATH;
  if (exec && path.isAbsolute(exec)) {
    try {
      if (statSync(exec).isFile()) {
        accessSync(exec, constants.X_OK);
        return exec;
      }
    } catch {}
  }
  return 'claude';
}

const oneLine = (s) => String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim();

function cap(text, max, note) {
  if (text.length <= max) return text;
  let cut = max;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--; // don't split a surrogate pair
  return `${text.slice(0, cut)}\n${note}`;
}

// The topic index: one line per topic with its slug, title, summary, item count and path.
export const topicLine = (t) => `- ${t.slug}: ${t.title}${t.summary ? ` — ${t.summary}` : ''} (${t.count} items) ${t.path}`;
const topicLines = (topics) => (topics.length ? ['Topics:', ...topics.map(topicLine)] : ['Topics: none yet.']);

function buildPrompt({ rules, turn, real, topics, message, answer }) {
  const turnFile = queueFile(real, turn);
  return [
    rules.trim(),
    '',
    '# This turn',
    '',
    `Current turn: ${turn}`,
    '',
    'Memory files:',
    ...MEMORY_FILES.map((f) => `- ${memoryPath(real, f)}`),
    '',
    ...topicLines(topics),
    '',
    "The user's message, verbatim:",
    '<message>',
    cap(message, MESSAGE_MAX, `[message truncated; full text in ${turnFile}]`),
    '</message>',
    '',
    "The assistant's final answer:",
    '<answer>',
    cap(answer, ANSWER_MAX, '[answer truncated]'),
    '</answer>',
  ].join('\n');
}

// Order and rule syntax per docs/verified.md section 5: the prompt goes right after -p, before
// the variadic --tools / --allowedTools. Read only: the change list comes back on stdout.
function curatorArgs(prompt, model, real) {
  const rules = [
    ...MEMORY_FILES.map((f) => `Read(/${memoryPath(real, f)})`),
    `Read(/${path.join(slateOf(real), 'topics')}/**)`,
  ];
  return [
    '-p', prompt,
    '--model', model,
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(CHANGE_SCHEMA),
    '--tools', 'Read',
    '--allowedTools', ...rules,
  ];
}

// The child leads its own process group, so one kill also reaches anything it started
// (e.g. the real claude under a wrapper shim that doesn't exec).
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

// Resolves `{ error, stdout }`: error is null on success, ABORTED once `signal` fires, else a
// one-line detail. Never rejects.
export function runClaude(bin, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let grace;
    let exit;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      aborted = true;
      if (child) killGroup(child);
      if (exit) finish(ABORTED);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      // A process outside the group may still hold a pipe open; don't let it keep us alive.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve({ error, stdout });
    };
    const outcome = () => {
      if (aborted) return ABORTED;
      if (timedOut) return 'timeout';
      if (exit.code === 0) return null;
      const tail = oneLine(stderr).slice(-STDERR_MAX);
      return `${exit.signal ? `killed by ${exit.signal}` : `exit ${exit.code}`}${tail ? `: ${tail}` : ''}`;
    };
    if (signal?.aborted) {
      finish(ABORTED);
      return;
    }
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      finish(`spawn failed: ${e.message}`);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < STDOUT_MAX) stdout += d;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_MAX * 4);
    });
    child.on('error', (e) => finish(e.message));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      clearTimeout(timer);
      killGroup(child); // nothing it left behind keeps running
      grace = setTimeout(() => finish(outcome()), timedOut || aborted ? 0 : STDERR_GRACE_MS);
    });
    child.on('close', () => {
      if (exit) finish(outcome());
    });
  });
}

// The change list from `--output-format json`: the result's top-level structured_output, with its
// ops and the IDs relevant to the turn.
export function parseChanges(stdout) {
  try {
    const out = JSON.parse(stdout)?.structured_output;
    if (!Array.isArray(out?.ops)) return null;
    return { ops: out.ops, relevant: Array.isArray(out.relevant) ? out.relevant : [] };
  } catch {
    return null;
  }
}

const retryNote = (errors) =>
  'Your previous change list was rejected, so nothing was applied. ' +
  `Problems, as <op index>:<problem>: ${errors.join('; ')}. ` +
  'Memory may have changed since your read; reread the files, then return the whole corrected list.';

// What an apply did, for the log: tokens only, never item text. Demotions are not warnings.
const summary = ({ applied, skipped, demoted }) => [
  applied.length ? `applied ${applied.join(', ')}` : 'applied nothing',
  skipped.length ? `skipped ${skipped.join(', ')}` : '',
  demoted.length ? `demoted ${demoted.join(', ')}` : '',
].filter(Boolean).join('; ');

async function log(dir, turn, status, detail) {
  const line = `${new Date().toISOString()} t${turn} ${status}: ${oneLine(detail)}\n`;
  try {
    await fs.appendFile(path.join(dir, 'curator.log'), line);
  } catch {}
}

// One turn; the caller holds the session's curator.lock. Attempt 1 applies strictly; on errors the
// model sees them and attempt 2 applies leniently. A run that fails or is aborted applies nothing.
async function curateTurn({ dir, turn, model, bin, timeoutMs, signal }) {
  let attempts = 0;
  const end = async (status, detail, result) => {
    await log(dir, turn, status, detail);
    return { ok: status === 'ok', attempts, ...result };
  };
  const failed = (detail) => end('error', detail, { errors: [`error: ${detail}`], error: true });
  try {
    const real = realpathSync(dir);
    const state = await turnState(dir, turn);
    const read = await readTurn(dir, turn);
    const answer = state?.answered ? read.answer : NO_ANSWER;
    const base = buildPrompt({
      rules: await fs.readFile(RULES_FILE, 'utf8'),
      turn,
      real,
      topics: await listTopics(slateOf(real)),
      message: read.message,
      answer,
    });
    const opts = {
      cwd: slateOf(real),
      env: curatorEnv(process.env),
      timeoutMs,
      signal,
    };

    let prompt = base;
    for (;;) {
      attempts++;
      const run = await runClaude(bin, curatorArgs(prompt, model, real), opts);
      if (run.error === ABORTED || signal?.aborted) {
        return end('aborted', 'requeued', { errors: ['aborted: requeued'], aborted: true });
      }
      if (run.error) return failed(run.error);
      const changes = parseChanges(run.stdout);
      if (!changes) return failed('no change list in output');
      const lenient = attempts === MAX_ATTEMPTS;
      const r = await applyChanges(dir, changes.ops, {
        turn, sessionId: path.basename(dir), lenient, relevant: changes.relevant,
      });
      if (r.errors.length === 0) return end('ok', `attempt ${attempts}: ${summary(r)}`, { errors: [] });
      if (lenient) return end('partial', `${r.errors.join('; ')}; ${summary(r)}`, { errors: r.errors, partial: true });
      await log(dir, turn, 'retry', r.errors.join('; '));
      prompt = `${base}\n\n${retryNote(r.errors)}`;
    }
  } catch (e) {
    return failed(oneLine(e.message));
  }
}

export async function runCurator({
  dir, turn, model = 'sonnet', bin = resolveClaudeBin(), timeoutMs = TIMEOUT_MS, signal,
}) {
  let release;
  try {
    release = await acquire(dir);
  } catch (e) {
    return { ok: false, attempts: 0, errors: [`error: ${oneLine(e.message)}`] };
  }
  if (!release) return { ok: false, attempts: 0, errors: ['locked'] };
  try {
    return await curateTurn({ dir, turn, model, bin, timeoutMs, signal });
  } finally {
    await release();
  }
}

// --- queue ---
// curated.json `{ turn, size, retry? }`: the last turn curated and its turn file's size when it was
// read (readCurated in session.mjs), plus `retry`, a later turn whose curation ended in an error
// and gets one more try. Only the lock holder writes it.

const CURATED = 'curated.json';

const writeCurated = (dir, { turn, size, retry }) =>
  atomicWrite(path.join(dir, CURATED), `${JSON.stringify(retry ? { turn, size, retry } : { turn, size })}\n`);

// Changes whenever a hook records a message or an answer, so whenever a Stop may have asked for a
// drain.
async function queueMark(dir) {
  const last = (await readSession(dir)).turn;
  return `${last}:${(await turnState(dir, last))?.size ?? 0}`;
}

// The next turn to curate, or null. First the last done turn again if its file grew (a
// continuation), else the turn after it. The newest turn waits for its answer; an older turn
// without one was interrupted. An older turn with no file is skipped (`missing`). `last` is the
// newest turn when the work was picked: only that turn's file can still grow.
async function nextWork(dir) {
  const done = await readCurated(dir);
  const last = (await readSession(dir)).turn;
  if (done.turn >= 1 && done.turn <= last) {
    const st = await turnState(dir, done.turn);
    if (st && st.size > done.size) return { turn: done.turn, size: st.size, missing: false, last };
  }
  const turn = done.turn + 1;
  if (turn > last) return null;
  const st = await turnState(dir, turn);
  if (turn === last && !st?.answered) return null;
  return { turn, size: st?.size ?? 0, missing: !st, last };
}

// Curates every pending turn in order. A curator that finds the lock held returns at once: the
// holder rechecks after its release, so the work isn't lost. A turn whose curation ends in an
// error (not a partial apply) stays queued once, for the next drain: a later Stop, or one that
// came in during this run; a second error marks it done. `beforeRelease` is a test seam.
export async function drain({
  dir, model = 'sonnet', bin = resolveClaudeBin(), timeoutMs = TIMEOUT_MS, signal, beforeRelease,
} = {}) {
  const runs = [];
  const result = (locked) => ({ runs, locked, aborted: Boolean(signal?.aborted) });
  for (;;) {
    if (signal?.aborted) return result(false);
    const release = await acquire(dir);
    if (!release) return result(true);
    let parked = null; // the queue mark from before a turn's first error
    try {
      for (let work; !signal?.aborted && (work = await nextWork(dir));) {
        if (!work.missing) {
          const mark = await queueMark(dir);
          const r = await curateTurn({ dir, turn: work.turn, model, bin, timeoutMs, signal });
          runs.push({ turn: work.turn, ...r });
          if (r.aborted) break; // not marked done: the next drain curates it again
          const done = await readCurated(dir);
          if (r.error && done.retry !== work.turn) {
            await writeCurated(dir, { ...done, retry: work.turn }); // still queued
            parked = mark;
            break;
          }
        }
        await writeCurated(dir, work);
        // A late follow-up can still append to the newest turn, so its file stays until a newer one.
        // `work.last`, not the current newest: a turn that was newest while it was curated may have
        // grown since, and must be curated again before its file goes.
        await sweepQueue(dir, Math.min(work.turn, work.last - 1));
      }
      if (beforeRelease && !signal?.aborted) await beforeRelease();
    } finally {
      await release();
    }
    if (signal?.aborted || !(await nextWork(dir))) return result(false);
    // A parked turn waits for the next drain, unless one was asked for while this one ran.
    if (parked !== null && (await queueMark(dir)) === parked) return result(false);
  }
}

async function main([dir, turnArg, model]) {
  const turn = Number(turnArg);
  if (!dir || !Number.isInteger(turn) || turn < 1) {
    process.stderr.write('usage: node curate.mjs <dir> <turn> [model]\n');
    process.exitCode = 1;
    return;
  }
  // SIGTERM (from a SessionStart clear/fork that must move this folder): abort, release, exit.
  const ac = new AbortController();
  process.on('SIGTERM', () => ac.abort());
  try {
    const r = await drain({ dir: path.resolve(dir), model: model || undefined, signal: ac.signal });
    process.exitCode = r.aborted || r.runs.some((x) => !x.ok) ? 1 : 0;
  } catch (e) {
    process.stderr.write(`slate curator: ${oneLine(e.message)}\n`);
    process.exitCode = 1;
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) await main(process.argv.slice(2));
