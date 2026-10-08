// Curator runner: snapshot the five memory files, let a fresh `claude -p` edit them, then keep the
// edit only if the safety check passes. One retry with the violations; otherwise restore.
// CLI: node curate.mjs <dir> <turn> [model]
import fs from 'node:fs/promises';
import { realpathSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeMemory, readTurn } from './lib/session.mjs';
import { acquire } from './lib/lock.mjs';
import { checkCuratorEdit } from './lib/check.mjs';
import { MEMORY_FILES } from './lib/items.mjs';

const RULES_FILE = new URL('../curator-rules.md', import.meta.url);
const ANSWER_MAX = 12000;
const MESSAGE_MAX = 100_000; // keeps argv well under ARG_MAX (E2BIG)
const TIMEOUT_MS = 300_000;
const STDERR_MAX = 300;
const STDERR_GRACE_MS = 500;
const MAX_ATTEMPTS = 2;

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

function curatorEnv(env) {
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

function buildPrompt({ rules, turn, real, message, answer }) {
  const turnFile = path.join(real, 'conversation', `${String(turn).padStart(4, '0')}.md`);
  return [
    rules.trim(),
    '',
    '# This turn',
    '',
    `Current turn: ${turn}`,
    `New items get \`t${turn}\`. Retired lines get \`retired t${turn}\`. Adopted plain bullets get \`t0\`.`,
    '',
    'Memory files:',
    ...MEMORY_FILES.map((f) => `- ${path.join(real, f)}`),
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
// the variadic --tools / --allowedTools. An Edit(//abs) rule also covers Write.
function curatorArgs(prompt, model, real) {
  const rules = MEMORY_FILES.flatMap((f) => {
    const abs = path.join(real, f);
    return [`Read(/${abs})`, `Edit(/${abs})`];
  });
  return [
    '-p', prompt,
    '--model', model,
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Edit,Write',
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

// Resolves null on success, else a one-line error detail. Never rejects.
function runClaude(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let grace;
    let exit;
    let settled = false;
    let timedOut = false;
    let stderr = '';
    const finish = (detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // A process outside the group may still hold stderr open; don't let it keep us alive.
      child?.stderr?.destroy();
      child?.unref();
      resolve(detail);
    };
    const outcome = () => {
      if (timedOut) return 'timeout';
      if (exit.code === 0) return null;
      const tail = oneLine(stderr).slice(-STDERR_MAX);
      return `${exit.signal ? `killed by ${exit.signal}` : `exit ${exit.code}`}${tail ? `: ${tail}` : ''}`;
    };
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    } catch (e) {
      finish(`spawn failed: ${e.message}`);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_MAX * 4);
    });
    child.on('error', (e) => finish(e.message));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      clearTimeout(timer);
      killGroup(child); // nothing it left behind may edit after the check
      grace = setTimeout(() => finish(outcome()), timedOut ? 0 : STDERR_GRACE_MS);
    });
    child.on('close', () => {
      if (exit) finish(outcome());
    });
  });
}

// Raw bytes of the five files; null for a file that doesn't exist.
async function snapshot(dir) {
  const out = {};
  for (const f of MEMORY_FILES) {
    try {
      out[f] = await fs.readFile(path.join(dir, f));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      out[f] = null;
    }
  }
  return out;
}

// What checkCuratorEdit sees: same as readMemory, absent files read as ''.
const asText = (snap) => Object.fromEntries(MEMORY_FILES.map((f) => [f, snap[f]?.toString('utf8') ?? '']));

const sameBytes = (a, b) => (a === null || b === null ? a === b : a.equals(b));

async function restore(dir, snap) {
  const now = await snapshot(dir);
  const rewrite = {};
  for (const f of MEMORY_FILES) {
    if (sameBytes(now[f], snap[f])) continue;
    if (snap[f] === null) await fs.rm(path.join(dir, f), { force: true });
    else rewrite[f] = snap[f];
  }
  if (Object.keys(rewrite).length) await writeMemory(dir, rewrite);
}

async function log(dir, turn, status, detail) {
  const line = `${new Date().toISOString()} t${turn} ${status}: ${oneLine(detail)}\n`;
  try {
    await fs.appendFile(path.join(dir, 'curator.log'), line);
  } catch {}
}

function changedFiles(before, after) {
  const files = MEMORY_FILES.filter((f) => !sameBytes(before[f], after[f]));
  return files.length ? `changed ${files.join(', ')}` : 'no change';
}

export async function runCurator({
  dir, turn, model = 'sonnet', bin = resolveClaudeBin(), timeoutMs = TIMEOUT_MS,
}) {
  let release;
  try {
    release = await acquire(dir);
  } catch (e) {
    return { ok: false, attempts: 0, violations: [`error: ${oneLine(e.message)}`] };
  }
  if (!release) return { ok: false, attempts: 0, violations: ['locked'] };

  let before;
  let attempts = 0;
  try {
    before = await snapshot(dir);
    const real = realpathSync(dir);
    const { message, answer } = await readTurn(dir, turn);
    const base = buildPrompt({ rules: await fs.readFile(RULES_FILE, 'utf8'), turn, real, message, answer });
    const opts = {
      cwd: path.dirname(path.dirname(real)), // the project dir: <project>/.slate/<id>
      env: curatorEnv(process.env),
      timeoutMs,
    };

    let prompt = base;
    let violations = [];
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      const err = await runClaude(bin, curatorArgs(prompt, model, real), opts);
      if (err) {
        await restore(dir, before);
        await log(dir, turn, 'error', err);
        return { ok: false, attempts, violations: [`error: ${err}`] };
      }
      const after = await snapshot(dir);
      violations = checkCuratorEdit(asText(before), asText(after), turn);
      if (violations.length === 0) {
        await log(dir, turn, 'ok', `attempt ${attempts}, ${changedFiles(before, after)}`);
        return { ok: true, attempts, violations: [] };
      }
      await restore(dir, before);
      if (attempts < MAX_ATTEMPTS) {
        await log(dir, turn, 'retry', violations.join('; '));
        prompt = `${base}\n\nYour previous edit was rejected and undone: ${violations.join('; ')}. Fix and retry.`;
      }
    }
    await log(dir, turn, 'restored', violations.join('; '));
    return { ok: false, attempts, violations };
  } catch (e) {
    const detail = oneLine(e.message);
    try {
      if (before) await restore(dir, before);
    } catch {}
    await log(dir, turn, 'error', detail);
    return { ok: false, attempts, violations: [`error: ${detail}`] };
  } finally {
    await release();
  }
}

async function main([dir, turnArg, model]) {
  const turn = Number(turnArg);
  if (!dir || !Number.isInteger(turn) || turn < 1) {
    process.stderr.write('usage: node curate.mjs <dir> <turn> [model]\n');
    process.exitCode = 1;
    return;
  }
  const r = await runCurator({ dir: path.resolve(dir), turn, model: model || undefined });
  process.exitCode = r.ok ? 0 : 1;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) await main(process.argv.slice(2));
