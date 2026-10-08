// Curator runner: snapshot the five memory files, let a fresh `claude -p` edit them, then keep the
// edit only if the safety check passes. One retry with the violations; otherwise restore.
// CLI: node curate.mjs <dir> <turn> [model]
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMemory, writeMemory, readTurn } from './lib/session.mjs';
import { acquire } from './lib/lock.mjs';
import { checkCuratorEdit } from './lib/check.mjs';
import { MEMORY_FILES } from './lib/items.mjs';

const RULES_FILE = new URL('../curator-rules.md', import.meta.url);
const ANSWER_MAX = 12000;
const TIMEOUT_MS = 300_000;
const STDERR_MAX = 300;
const MAX_ATTEMPTS = 2;

const oneLine = (s) => String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim();

function capAnswer(answer) {
  if (answer.length <= ANSWER_MAX) return answer;
  let cut = ANSWER_MAX;
  const c = answer.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--; // don't split a surrogate pair
  return `${answer.slice(0, cut)}\n[answer truncated]`;
}

function buildPrompt({ rules, turn, real, message, answer }) {
  return [
    rules.trim(),
    '',
    '# This turn',
    '',
    `Current turn: ${turn}`,
    `New items get \`t${turn}\`. Retired lines get \`retired t${turn}\`.`,
    '',
    'Memory files:',
    ...MEMORY_FILES.map((f) => `- ${path.join(real, f)}`),
    '',
    "The user's message, verbatim:",
    '<message>',
    message,
    '</message>',
    '',
    "The assistant's final answer:",
    '<answer>',
    capAnswer(answer),
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

// Resolves null on success, else a one-line error detail. Never rejects.
function runClaude(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = '';
    let timer;
    const finish = (detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(detail);
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      finish(`spawn failed: ${e.message}`);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_MAX * 4);
    });
    child.on('error', (e) => finish(e.message));
    // After a timeout kill, don't wait for stderr to close: a grandchild could hold it open.
    child.on('exit', () => {
      if (timedOut) finish('timeout');
    });
    child.on('close', (code, signal) => {
      if (timedOut) return finish('timeout');
      if (code === 0) return finish(null);
      const tail = oneLine(stderr).slice(-STDERR_MAX);
      finish(`${signal ? `killed by ${signal}` : `exit ${code}`}${tail ? `: ${tail}` : ''}`);
    });
  });
}

async function restore(dir, snapshot) {
  const now = await readMemory(dir);
  const changed = {};
  for (const f of MEMORY_FILES) if (now[f] !== snapshot[f]) changed[f] = snapshot[f];
  if (Object.keys(changed).length) await writeMemory(dir, changed);
}

async function log(dir, turn, status, detail) {
  const line = `${new Date().toISOString()} t${turn} ${status}: ${oneLine(detail)}\n`;
  try {
    await fs.appendFile(path.join(dir, 'curator.log'), line);
  } catch {}
}

function changedFiles(before, after) {
  const files = MEMORY_FILES.filter((f) => before[f] !== after[f]);
  return files.length ? `changed ${files.join(', ')}` : 'no change';
}

export async function runCurator({
  dir, turn, model = 'sonnet', bin = process.env.SLATE_CLAUDE_BIN || 'claude', timeoutMs = TIMEOUT_MS,
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
    before = await readMemory(dir);
    const real = realpathSync(dir);
    const { message, answer } = await readTurn(dir, turn);
    const base = buildPrompt({ rules: await fs.readFile(RULES_FILE, 'utf8'), turn, real, message, answer });
    const opts = {
      cwd: path.dirname(path.dirname(real)), // the project dir: <project>/.slate/<id>
      env: { ...process.env, SLATE_CURATOR: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
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
      const after = await readMemory(dir);
      violations = checkCuratorEdit(before, after, turn);
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
