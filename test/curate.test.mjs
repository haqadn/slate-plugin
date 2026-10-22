import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runCurator, drain, resolveClaudeBin, CURATOR_ENV_DENY } from '../plugins/slate/scripts/curate.mjs';
import { CHANGE_SCHEMA, applyChanges } from '../plugins/slate/scripts/lib/apply.mjs';
import { slateOf, memoryPath } from '../plugins/slate/scripts/lib/slate.mjs';
import { initSession } from './helpers.mjs';
import {
  writeMessage, appendAnswer, appendContinuation, readMemory, writeMemory, readSession, writeSession,
} from '../plugins/slate/scripts/lib/session.mjs';
import { acquire } from '../plugins/slate/scripts/lib/lock.mjs';
import { MEMORY_FILES } from '../plugins/slate/scripts/lib/items.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SHIM = fileURLToPath(new URL('./fixtures/fake-claude-shim.sh', import.meta.url));
const CURATE = fileURLToPath(new URL('../plugins/slate/scripts/curate.mjs', import.meta.url));
const RULES = fileURLToPath(new URL('../plugins/slate/curator-rules.md', import.meta.url));
// Tests must never reach a real claude: drop what resolveClaudeBin would pick up from this shell.
delete process.env.SLATE_CLAUDE_BIN;
delete process.env.CLAUDE_CODE_EXECPATH;
const ENV_KEYS = [...new Set([
  'FAKE_MODE', 'FAKE_RECORD', 'FAKE_SLEEP_MS', 'SLATE_CLAUDE_BIN', 'SLATE_TEST_INHERITED',
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'ANTHROPIC_BASE_URL', ...CURATOR_ENV_DENY,
])];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const temps = [];
// Belt and braces: a bin that falls through to plain `claude` hits this stub, never a real model.
const NO_CLAUDE = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-noclaude-'));
temps.push(NO_CLAUDE);
await fs.writeFile(path.join(NO_CLAUDE, 'claude'), '#!/bin/sh\necho "test reached claude on PATH" >&2\nexit 97\n', {
  mode: 0o755,
});
process.env.PATH = `${NO_CLAUDE}${path.delimiter}${process.env.PATH}`;
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const INSTRUCTIONS = '# Instructions\n- [I1 t1] use npm\n- prefer tabs\n';
const SUPERSEDED = '# Superseded\n- [I2 t1 retired t1] use yarn (reason: user chose npm)\n';
// The fake's add for turn 2, after the apply step adopted the plain bullet as I3.
const GOOD_INSTRUCTIONS = '# Instructions\n- [I1 t1] use npm\n- [I3 t0] prefer tabs\n- [I4 t2@sid] fake item 2\n';
const TURN = 2;

async function setup(mode, { message = 'switch to pnpm', answer = 'Done, using pnpm.' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-curate-'));
  temps.push(root);
  const { dir } = await initSession(root, 'sid', 1);
  await writeMemory(dir, {
    'instructions.md': INSTRUCTIONS,
    'facts.md': '# Facts\n- [F1 t1] Node 24 (package.json)\n',
    'now.md': 'Goal: set up the project\n',
    'superseded.md': SUPERSEDED,
  });
  await writeMessage(dir, TURN, message);
  await appendAnswer(dir, TURN, answer);
  const record = path.join(root, 'record.jsonl');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_RECORD = record;
  return { root, dir, record, before: await readMemory(dir) };
}

const exists = (p) => fs.access(p).then(() => true, () => false);
async function calls(record) {
  try {
    return (await fs.readFile(record, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
async function logLines(dir) {
  try {
    return (await fs.readFile(path.join(dir, 'curator.log'), 'utf8')).split('\n').filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
function assertLog(line, status) {
  const m = /^(\S+) t(\d+) (ok|retry|partial|error): (.*)$/.exec(line);
  assert.ok(m, `bad log line: ${line}`);
  assert.ok(!Number.isNaN(Date.parse(m[1])), `bad timestamp: ${m[1]}`);
  assert.equal(new Date(m[1]).toISOString(), m[1]);
  assert.equal(Number(m[2]), TURN);
  assert.equal(m[3], status);
  return m[4];
}
const lockGone = async (dir) => !(await exists(path.join(dir, 'curator.lock')));
const flag = (args, name) => args[args.indexOf(name) + 1];

test('command: prompt first, every flag, read-only path-scoped rules, the change schema, env, cwd, stdin ignored', async () => {
  const { root, dir, record } = await setup('good');
  process.env.SLATE_TEST_INHERITED = 'yes';
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.equal(r.ok, true);
  const [call] = await calls(record);
  const { args, env } = call;

  assert.equal(args[0], '-p');
  assert.equal(args[1], call.prompt);
  assert.ok(args[1].includes('Current turn: 2'));
  assert.equal(flag(args, '--model'), 'sonnet');
  assert.equal(flag(args, '--settings'), '{"disableAllHooks":true}');
  assert.equal(flag(args, '--setting-sources'), '');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
    assert.ok(args.includes(f), f);
  }
  assert.equal(flag(args, '--permission-mode'), 'dontAsk');
  assert.equal(flag(args, '--tools'), 'Read');
  assert.equal(flag(args, '--output-format'), 'json');
  assert.deepEqual(JSON.parse(flag(args, '--json-schema')), CHANGE_SCHEMA);
  for (const a of args.slice(2)) assert.doesNotMatch(a, /\b(Edit|Write)\b/, 'no write tool or rule');

  const real = realpathSync(dir);
  if (process.platform === 'darwin') assert.notEqual(real, dir, 'tmpdir goes through a symlink on macOS');
  const rules = MEMORY_FILES.map((f) => `Read(/${memoryPath(real, f)})`);
  // --allowedTools is variadic, so it comes last and takes exactly the five rules.
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), rules);
  for (const rule of rules) assert.match(rule, /^Read\(\/\/.+\.md\)$/);
  assert.ok(args.indexOf('--tools') < args.indexOf('--allowedTools'));

  assert.equal(env.SLATE_CURATOR, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(env.SLATE_TEST_INHERITED, 'yes');
  assert.equal(call.cwd, slateOf(real));
  assert.equal(call.stdinRdev, statSync('/dev/null').rdev);
});

test('command: --model override; bin defaults to SLATE_CLAUDE_BIN over CLAUDE_CODE_EXECPATH', async () => {
  const { dir, record } = await setup('good');
  process.env.SLATE_CLAUDE_BIN = FAKE;
  process.env.CLAUDE_CODE_EXECPATH = '/usr/bin/false';
  const r = await runCurator({ dir, turn: TURN, model: 'haiku' });
  assert.equal(r.ok, true);
  const [call] = await calls(record);
  assert.equal(flag(call.args, '--model'), 'haiku');
});

test('prompt: rules, turn, full message, capped answer, five absolute paths', async () => {
  const message = [
    'use npm, and keep `$HOME/x` and "quotes" exactly',
    '<!-- slate:answer -->',
    'm'.repeat(20000),
    'MESSAGE_END',
  ].join('\n');
  const answer = `${'a'.repeat(12000)}ANSWER_TAIL`;
  const { dir, record } = await setup('good', { message, answer });
  await runCurator({ dir, turn: TURN, bin: FAKE });
  const [{ prompt }] = await calls(record);

  assert.ok(prompt.includes((await fs.readFile(RULES, 'utf8')).trim()), 'rules');
  assert.ok(prompt.includes('Current turn: 2'), 'turn');
  assert.ok(prompt.includes(message), 'message verbatim');
  assert.ok(prompt.includes('a'.repeat(12000)), 'answer kept up to the cap');
  assert.ok(!prompt.includes('ANSWER_TAIL'), 'answer capped');
  assert.ok(prompt.includes('[answer truncated]'));
  const real = realpathSync(dir);
  for (const f of MEMORY_FILES) assert.ok(prompt.includes(memoryPath(real, f)), f);
});

test('prompt: a short answer is passed whole, without a truncation note', async () => {
  const { dir, record } = await setup('good');
  await runCurator({ dir, turn: TURN, bin: FAKE });
  const [{ prompt }] = await calls(record);
  assert.ok(prompt.includes('switch to pnpm'));
  assert.ok(prompt.includes('Done, using pnpm.'));
  assert.ok(!prompt.includes('[answer truncated]'));
  assert.ok(!prompt.includes('rejected'));
});

test('prompt: a message over 100,000 chars is capped, pointing at the turn file', async () => {
  const message = `${'m'.repeat(100000)}MESSAGE_TAIL`;
  const { dir, record } = await setup('good', { message });
  await runCurator({ dir, turn: TURN, bin: FAKE });
  const [{ prompt }] = await calls(record);
  assert.ok(prompt.includes('m'.repeat(100000)));
  assert.ok(!prompt.includes('MESSAGE_TAIL'));
  const turnFile = path.join(realpathSync(dir), 'queue', '0002.md');
  assert.ok(prompt.includes(`[message truncated; full text in ${turnFile}]`));
});

test('env: deny-listed session vars are stripped, everything else is inherited', async () => {
  const { dir, record } = await setup('good');
  assert.deepEqual([...CURATOR_ENV_DENY].sort(), [
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_PARENT_SESSION_ID',
    'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_CODE_SESSION_NAME',
    'CLAUDE_CODE_SESSION_LOG', 'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_JOB_DIR',
    'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_ENV_FILE', 'CLAUDE_EFFORT',
  ].sort());
  for (const k of CURATOR_ENV_DENY) process.env[k] = `deny-${k}`;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  process.env.ANTHROPIC_BASE_URL = 'http://slate.test';
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.equal(r.ok, true);
  const [{ env }] = await calls(record);
  for (const k of CURATOR_ENV_DENY) assert.ok(!(k in env), k);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://slate.test');
  assert.equal(env.CLAUDECODE, '1');
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, '1');
  assert.equal(env.SLATE_CURATOR, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('bin: SLATE_CLAUDE_BIN, then an executable absolute CLAUDE_CODE_EXECPATH, then claude', () => {
  assert.equal(resolveClaudeBin({ SLATE_CLAUDE_BIN: '/x/fake', CLAUDE_CODE_EXECPATH: FAKE }), '/x/fake');
  assert.equal(resolveClaudeBin({ CLAUDE_CODE_EXECPATH: FAKE }), FAKE);
  assert.equal(resolveClaudeBin({ CLAUDE_CODE_EXECPATH: RULES }), 'claude', 'not executable');
  assert.equal(resolveClaudeBin({ CLAUDE_CODE_EXECPATH: path.dirname(FAKE) }), 'claude', 'a directory');
  assert.equal(resolveClaudeBin({ CLAUDE_CODE_EXECPATH: '/nonexistent/claude' }), 'claude');
  assert.equal(resolveClaudeBin({ CLAUDE_CODE_EXECPATH: 'test/fixtures/fake-claude.mjs' }), 'claude', 'relative');
  assert.equal(resolveClaudeBin({}), 'claude');
});

test('bin: runCurator uses CLAUDE_CODE_EXECPATH, read before it is stripped from the child env', async () => {
  const { dir, record } = await setup('good');
  process.env.CLAUDE_CODE_EXECPATH = FAKE;
  const r = await runCurator({ dir, turn: TURN });
  assert.equal(r.ok, true);
  const [{ env }] = await calls(record);
  assert.ok(!('CLAUDE_CODE_EXECPATH' in env));
});

test('good: applies the change list, logs ok, releases the lock', async () => {
  const { dir, record, before } = await setup('good');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: true, attempts: 1, errors: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], GOOD_INSTRUCTIONS);
  for (const f of MEMORY_FILES) if (f !== 'instructions.md') assert.equal(now[f], before[f], f);
  const log = await logLines(dir);
  assert.equal(log.length, 1);
  assert.equal(assertLog(log[0], 'ok'), 'attempt 1: applied adopt I3, 0:add I4');
  assert.equal((await calls(record)).length, 1);
  assert.ok(await lockGone(dir));
});

test('invalid twice: the retry applies the valid ops, drops the rest and logs partial', async () => {
  const { dir, record, before } = await setup('invalid');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: false, attempts: 2, errors: ['1:no source'], partial: true });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], GOOD_INSTRUCTIONS);
  for (const f of MEMORY_FILES) if (f !== 'instructions.md') assert.equal(now[f], before[f], f);
  const log = await logLines(dir);
  assert.equal(log.length, 2);
  assert.equal(assertLog(log[0], 'retry'), '1:no source');
  assert.equal(assertLog(log[1], 'partial'), '1:no source; applied adopt I3, 0:add I4');
  assert.equal((await calls(record)).length, 2);
  assert.ok(await lockGone(dir));
});

test('invalid-then-good: the first list applies nothing; the retry prompt lists its errors', async () => {
  const { dir, record } = await setup('invalid-then-good');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: true, attempts: 2, errors: [] });
  assert.equal((await readMemory(dir))['instructions.md'], GOOD_INSTRUCTIONS);
  const [first, second] = await calls(record);
  assert.equal(second.seen, INSTRUCTIONS, 'memory as it was, not even an adoption');
  assert.ok(!first.prompt.includes('rejected'));
  assert.ok(second.prompt.startsWith(first.prompt));
  const note = second.prompt.slice(first.prompt.length);
  assert.ok(note.includes('rejected') && note.includes('1:no source'), note);
  assert.ok(note.includes('Memory may have changed since your read; reread the files'), note);
  const log = await logLines(dir);
  assert.equal(log.length, 2);
  assert.equal(assertLog(log[0], 'retry'), '1:no source');
  assert.equal(assertLog(log[1], 'ok'), 'attempt 2: applied adopt I3, 0:add I4');
  assert.ok(await lockGone(dir));
});

test('stale: another session changed the item first; the retry rereads and replaces the newer one', async () => {
  const { dir, record } = await setup('stale');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: true, attempts: 2, errors: [] });
  const [first, second] = await calls(record);
  assert.ok(first.seen.includes('- [I1 t1] use npm'));
  assert.ok(second.seen.includes('- [I4 t3@0ther000] use bun'), "the retry read the other session's item");
  assert.ok(second.prompt.includes('0:stale I1'));
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], '# Instructions\n- [I5 t0] prefer tabs\n- [I6 t2@sid] use pnpm\n');
  assert.equal(now['superseded.md'], `${SUPERSEDED}` +
    '- [I1 t1 retired t3@0ther000] use npm (reason: other session chose bun)\n' +
    '- [I4 t3@0ther000 retired t2@sid] use bun (reason: user switched to pnpm)\n');
  const log = await logLines(dir);
  assert.equal(assertLog(log[0], 'retry'), '0:stale I1');
  assertLog(log[1], 'ok');
});

for (const [name, mode, bin] of [
  ['fail (exits 1)', 'fail', FAKE],
  ['output that is not JSON', 'garbage', FAKE],
  ['a result without structured_output', 'no-structured', FAKE],
  ['a binary that does not exist', 'good', '/nonexistent/slate-claude'],
]) {
  test(`${name}: logs error, leaves memory unchanged, releases the lock, does not throw`, async () => {
    const { dir, before } = await setup(mode);
    const r = await runCurator({ dir, turn: TURN, bin });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^error: /);
    assert.equal(r.error, true, 'an error, not a partial apply: the drain retries it once');
    assert.deepEqual(await readMemory(dir), before);
    const log = await logLines(dir);
    assert.equal(log.length, 1);
    assert.ok(assertLog(log[0], 'error').length > 0);
    assert.ok(await lockGone(dir));
  });
}

test('timeout: kills the child, logs error: timeout, leaves files unchanged', async () => {
  const { dir, record, before } = await setup('sleep');
  const t0 = Date.now();
  const r = await runCurator({ dir, turn: TURN, bin: FAKE, timeoutMs: 1000 });
  assert.ok(Date.now() - t0 < 2500, 'returned before the fake finished sleeping');
  assert.deepEqual(r, { ok: false, attempts: 1, errors: ['error: timeout'], error: true });
  const log = await logLines(dir);
  assert.equal(log.length, 1);
  assert.equal(assertLog(log[0], 'error'), 'timeout');
  assert.deepEqual(await readMemory(dir), before);
  const [{ pid }] = await calls(record);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(await lockGone(dir));
});

test('timeout under a shim that does not exec: the whole group dies, no late edit', async () => {
  const { dir, record, before } = await setup('sleep');
  const r = await runCurator({ dir, turn: TURN, bin: SHIM, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, attempts: 1, errors: ['error: timeout'], error: true });
  assert.ok(await lockGone(dir));
  await new Promise((res) => setTimeout(res, 3000)); // the fake would have answered by now
  assert.deepEqual(await readMemory(dir), before);
  const [{ pid }] = await calls(record);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a process outside the group holding stderr open does not keep the runner waiting', async () => {
  const { dir, record } = await setup('orphan');
  const t0 = Date.now();
  try {
    const r = await runCurator({ dir, turn: TURN, bin: FAKE });
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0}ms`);
    assert.equal(r.ok, true);
  } finally {
    try {
      process.kill(Number(await fs.readFile(`${record}.orphan`, 'utf8')), 'SIGKILL');
    } catch {}
  }
});

test('lock held: returns without running and without logging', async () => {
  const { dir, record, before } = await setup('good');
  const release = await acquire(dir);
  try {
    const r = await runCurator({ dir, turn: TURN, bin: FAKE });
    assert.deepEqual(r, { ok: false, attempts: 0, errors: ['locked'] });
    assert.deepEqual(await calls(record), []);
    assert.deepEqual(await logLines(dir), []);
    assert.deepEqual(await readMemory(dir), before);
    assert.ok(!(await lockGone(dir)), 'the holder keeps its lock');
  } finally {
    await release();
  }
});

test("curator-rules.md: the worked example's change list applies as the example says", async () => {
  const rules = await fs.readFile(RULES, 'utf8');
  const before = '- [I1 t1@82b3114c] use npm';
  const added = '- [I2 t4@9f0e1a2b] use pnpm';
  const retired = '- [I1 t1@82b3114c retired t4@9f0e1a2b] use npm (reason: user switched to pnpm)';
  for (const line of [before, added, retired]) assert.ok(rules.includes(`\n${line}\n`), line);
  const { ops } = JSON.parse(/```json\n(.*)\n```/.exec(rules)[1]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-curate-'));
  temps.push(root);
  const { dir } = await initSession(root, '9f0e1a2b-session', 1);
  await writeMemory(dir, { 'instructions.md': `# Instructions\n${before}\n` });
  const r = await applyChanges(dir, ops, { turn: 4, sessionId: '9f0e1a2b-session' });
  assert.deepEqual(r.errors, []);
  const mem = await readMemory(dir);
  assert.equal(mem['instructions.md'], `# Instructions\n${added}\n`);
  assert.equal(mem['superseded.md'], `# Superseded\n${retired}\n`);
});

test('curator-rules.md: wording the curator relies on', async () => {
  const rules = await fs.readFile(RULES, 'utf8');
  for (const s of [
    'Instructions are shared by every session',
    '"For wpcom#249668: never touch X"',
    '"use the staging DB for this"',
    'Never write an ID for a new item.',
    'Name an existing ID only to retire or replace it.',
    'reread the files and decide again',
    'Never cite a report',
  ]) assert.ok(rules.includes(s), s);
  for (const s of ['Edit', 'Write', '.slate/', 'rejected']) assert.ok(!rules.includes(s), `no ${s}`);
});

test('CLI: node curate.mjs <dir> <turn> [model] drains the queue', async () => {
  const { dir, record } = await setup('good');
  await writeSession(dir, { ...(await readSession(dir)), turn: TURN });
  await promisify(execFile)(process.execPath, [CURATE, dir, String(TURN), 'haiku'], {
    env: { ...process.env, SLATE_CLAUDE_BIN: FAKE },
  });
  assert.equal((await readMemory(dir))['instructions.md'], GOOD_INSTRUCTIONS);
  const [call, ...rest] = await calls(record);
  assert.deepEqual(rest, [], 'turn 1 has no file and is skipped');
  assert.equal(flag(call.args, '--model'), 'haiku');
  const log = await logLines(dir);
  assert.equal(log.length, 1);
  assertLog(log[0], 'ok');
  assert.equal((await curated(dir)).turn, TURN);
});

// --- drain ---

const NO_ANSWER = '[no answer: turn was interrupted]';

// A session whose turns 1..n each have a message and (unless `answered(t)` is false) an answer.
async function queued(mode, n, { answered = () => true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-drain-'));
  temps.push(root);
  const { dir } = await initSession(root, 'sid', 1);
  for (let t = 1; t <= n; t++) await addTurn(dir, t, { answered: answered(t) });
  const record = path.join(root, 'record.jsonl');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_RECORD = record;
  return { root, dir, record, before: await readMemory(dir) };
}
async function addTurn(dir, t, { answered = true } = {}) {
  await writeMessage(dir, t, `message ${t}`);
  if (answered) await appendAnswer(dir, t, `answer ${t}`);
  await writeSession(dir, { ...(await readSession(dir)), turn: t });
}
async function curated(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'curated.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
const turnSize = async (dir, t) => (await fs.stat(path.join(dir, 'queue', `000${t}.md`))).size;
const queueFiles = async (dir) => (await fs.readdir(path.join(dir, 'queue'))).sort();
const promptTurns = async (record) => (await calls(record)).map((c) => Number(/^Current turn: (\d+)$/m.exec(c.prompt)[1]));
const logTurns = async (dir) => (await logLines(dir)).map((l) => / (t\d+ \w+):/.exec(l)[1]);
const runTurns = (r) => r.runs.map((x) => [x.turn, x.ok]);

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('drain: three turns queued while the lock is held are all curated, in order', async () => {
  const { dir, record } = await queued('good', 3);
  const release = await acquire(dir);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await drain({ dir, bin: FAKE }), { runs: [], locked: true, aborted: false });
  }
  assert.deepEqual(await calls(record), []);
  assert.deepEqual(await logLines(dir), []);
  await release();

  const r = await drain({ dir, bin: FAKE });
  assert.deepEqual(runTurns(r), [[1, true], [2, true], [3, true]]);
  assert.equal(r.locked, false);
  assert.deepEqual(await promptTurns(record), [1, 2, 3]);
  assert.deepEqual(await logTurns(dir), ['t1 ok', 't2 ok', 't3 ok']);
  assert.equal((await readMemory(dir))['instructions.md'],
    '# Instructions\n- [I1 t1@sid] fake item 1\n- [I2 t2@sid] fake item 2\n- [I3 t3@sid] fake item 3\n');
  assert.deepEqual(await curated(dir), { turn: 3, size: await turnSize(dir, 3) });
  assert.deepEqual(await queueFiles(dir), ['0003.md'], 'curated turns are swept; the newest stays');
  assert.ok(await lockGone(dir));
  assert.deepEqual((await drain({ dir, bin: FAKE })).runs, [], 'nothing left');
});

test('drain: a continuation appended after a turn is done gets that turn re-curated', async () => {
  const { dir, record } = await queued('good', 1);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, true]]);
  assert.deepEqual(await queueFiles(dir), ['0001.md'], 'the newest turn stays after curation');
  await appendContinuation(dir, 1, 'the real answer');
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, true]]);
  const [first, second] = await calls(record);
  assert.ok(!first.prompt.includes('the real answer'));
  assert.ok(second.prompt.includes('answer 1\n\nthe real answer'));
  assert.deepEqual(await curated(dir), { turn: 1, size: await turnSize(dir, 1) });
  assert.deepEqual((await drain({ dir, bin: FAKE })).runs, []);
  assert.equal((await calls(record)).length, 2);
});

test('drain: an interrupted turn is curated with a placeholder; the newest unanswered turn waits', async () => {
  const { dir, record } = await queued('good', 2, { answered: (t) => t !== 1 });
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, true], [2, true]]);
  const [first, second] = await calls(record);
  assert.ok(first.prompt.includes(`<answer>\n${NO_ANSWER}\n</answer>`));
  assert.ok(!second.prompt.includes(NO_ANSWER));

  await addTurn(dir, 3, { answered: false }); // still being answered
  assert.deepEqual((await drain({ dir, bin: FAKE })).runs, []);
  assert.equal((await curated(dir)).turn, 2);
  await appendAnswer(dir, 3, 'answer 3');
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[3, true]]);
  assert.ok(!(await calls(record))[2].prompt.includes(NO_ANSWER));
});

test('M6: a turn that ends in error is retried once on the next drain, then marked done', async () => {
  const { dir, record, before } = await queued('fail', 2);
  const size1 = await turnSize(dir, 1);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, false]], 'the first error parks turn 1');
  assert.deepEqual(await curated(dir), { turn: 0, size: 0, retry: 1 });
  assert.deepEqual(await queueFiles(dir), ['0001.md', '0002.md'], 'a parked turn keeps its file');
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, false], [2, false]], 'turn 1 done; turn 2 parked');
  assert.deepEqual(await curated(dir), { turn: 1, size: size1, retry: 2 });
  assert.deepEqual(await queueFiles(dir), ['0002.md'], 'turn 1 swept after its second error');
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[2, false]]);
  assert.deepEqual(await curated(dir), { turn: 2, size: await turnSize(dir, 2) });
  assert.deepEqual(await logTurns(dir), ['t1 error', 't1 error', 't2 error', 't2 error']);
  assert.deepEqual(await readMemory(dir), before);

  process.env.FAKE_MODE = 'good';
  await addTurn(dir, 3);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[3, true]]);
  assert.deepEqual(await promptTurns(record), [1, 1, 2, 2, 3]);
});

test('M6: a retry that succeeds keeps its change; a partial turn is never retried', async () => {
  const { dir } = await queued('fail', 1);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, false]]);
  process.env.FAKE_MODE = 'good';
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, true]]);
  assert.deepEqual(await curated(dir), { turn: 1, size: await turnSize(dir, 1) });
  assert.equal((await readMemory(dir))['instructions.md'], '# Instructions\n- [I1 t1@sid] fake item 1\n');

  process.env.FAKE_MODE = 'invalid'; // an unsourced fact, twice: dropped, the rest applied
  await addTurn(dir, 2);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[2, false]]);
  assert.deepEqual(await curated(dir), { turn: 2, size: await turnSize(dir, 2) }, 'marked done at once');
  assert.deepEqual((await drain({ dir, bin: FAKE })).runs, []);
  assert.deepEqual(await logTurns(dir), ['t1 error', 't1 ok', 't2 retry', 't2 partial']);
});

test('M6: a drain asked for while a turn errors retries it at once, then moves on', async () => {
  const { dir } = await queued('fail', 1);
  let concurrent;
  const r = await drain({
    dir,
    bin: FAKE,
    beforeRelease: async () => {
      if (concurrent) return;
      process.env.FAKE_MODE = 'good';
      await addTurn(dir, 2);
      concurrent = await drain({ dir, bin: FAKE }); // turn 2's Stop, while turn 1's error holds the lock
    },
  });
  assert.deepEqual(concurrent, { runs: [], locked: true, aborted: false });
  assert.deepEqual(runTurns(r), [[1, false], [1, true], [2, true]]);
  assert.deepEqual(await curated(dir), { turn: 2, size: await turnSize(dir, 2) });
  assert.ok(await lockGone(dir));
});

test('drain: work added just before the release is picked up by the recheck', async () => {
  const { dir, record } = await queued('good', 1);
  let concurrent;
  const r = await drain({
    dir,
    bin: FAKE,
    beforeRelease: async () => {
      if (concurrent) return;
      await addTurn(dir, 2);
      concurrent = await drain({ dir, bin: FAKE }); // the curator Stop spawned for turn 2
    },
  });
  assert.deepEqual(concurrent, { runs: [], locked: true, aborted: false });
  assert.deepEqual(runTurns(r), [[1, true], [2, true]]);
  assert.deepEqual(await promptTurns(record), [1, 2]);
  assert.equal((await curated(dir)).turn, 2);
  assert.ok(await lockGone(dir));
});

test('CLI: SIGTERM aborts mid-run: kills claude, applies nothing, logs aborted, releases, turn stays queued', async () => {
  const { dir, record, before } = await queued('hang', 1);
  const child = spawn(process.execPath, [CURATE, dir, '1', 'sonnet'], {
    env: { ...process.env, SLATE_CLAUDE_BIN: FAKE }, stdio: 'ignore',
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  await until(async () => (await calls(record)).length === 1);
  const t0 = Date.now();
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  assert.equal(signal, null, 'trapped, not killed by the signal');
  assert.equal(code, 1);
  assert.deepEqual(await readMemory(dir), before);
  const log = await logLines(dir);
  assert.equal(log.length, 1);
  assert.match(log[0], / t1 aborted: requeued$/);
  assert.ok(await lockGone(dir));
  assert.equal(await curated(dir), null, 'the aborted turn is not marked done');
  const [{ pid }] = await calls(record);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  process.env.FAKE_MODE = 'good';
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, true]]);
});

// --- queue sweep ---

test('queue: a parked turn keeps its file; the retry curates it and sweeps it', async () => {
  const { dir } = await queued('fail', 2);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, false]]);
  assert.deepEqual(await queueFiles(dir), ['0001.md', '0002.md']);
  process.env.FAKE_MODE = 'good';
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, true], [2, true]]);
  assert.deepEqual(await queueFiles(dir), ['0002.md']);
});

test('queue: a partial turn is swept once a newer turn exists', async () => {
  const { dir } = await queued('invalid', 2);
  assert.deepEqual(runTurns(await drain({ dir, bin: FAKE })), [[1, false], [2, false]]);
  assert.deepEqual(await logTurns(dir), ['t1 retry', 't1 partial', 't2 retry', 't2 partial']);
  assert.deepEqual(await queueFiles(dir), ['0002.md']);
});

test('queue: an aborted turn keeps its file', async () => {
  const { dir, record, before } = await queued('hang', 2);
  const ac = new AbortController();
  const running = drain({ dir, bin: FAKE, signal: ac.signal });
  await until(async () => (await calls(record)).length === 1);
  ac.abort();
  const r = await running;
  assert.equal(r.aborted, true);
  assert.deepEqual(await readMemory(dir), before, 'nothing applied');
  assert.deepEqual(await queueFiles(dir), ['0001.md', '0002.md']);
  assert.equal(await curated(dir), null);
});

test('queue: a continuation appended while the newest turn is curated is kept and re-curated', async () => {
  const { dir, record } = await queued('good', 1);
  let appended = false;
  const r = await drain({
    dir,
    bin: FAKE,
    beforeRelease: async () => {
      if (appended) return;
      appended = true;
      await appendContinuation(dir, 1, 'late follow-up');
    },
  });
  assert.deepEqual(runTurns(r), [[1, true], [1, true]]);
  assert.ok((await calls(record))[1].prompt.includes('answer 1\n\nlate follow-up'));
  assert.deepEqual(await queueFiles(dir), ['0001.md']);
  assert.deepEqual(await curated(dir), { turn: 1, size: await turnSize(dir, 1) });
});

test('queue: a follow-up appended mid-curation, then a new turn, is curated before its file is swept', async () => {
  const { dir, record } = await queued('sleep', 1);
  process.env.FAKE_SLEEP_MS = '500';
  const running = drain({ dir, bin: FAKE });
  await until(async () => (await calls(record)).length === 1);
  await appendContinuation(dir, 1, 'late follow-up'); // a background agent finishes
  await addTurn(dir, 2, { answered: false }); // then the user sends turn 2
  const r = await running;
  assert.deepEqual(runTurns(r), [[1, true], [1, true]]);
  assert.ok((await calls(record))[1].prompt.includes('answer 1\n\nlate follow-up'));
  assert.deepEqual(await queueFiles(dir), ['0002.md']);
});

test('a slate deleted while its curator runs: the apply fails and nothing is recreated', async () => {
  const { dir, record } = await queued('sleep', 1);
  process.env.FAKE_SLEEP_MS = '500';
  const running = drain({ dir, bin: FAKE }).catch(() => null);
  await until(async () => (await calls(record)).length === 1);
  await fs.rm(slateOf(dir), { recursive: true });
  await running;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await exists(slateOf(dir)), false);
});
