import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runCurator, resolveClaudeBin, CURATOR_ENV_DENY } from '../plugins/slate/scripts/curate.mjs';
import { initSession, writeMessage, appendAnswer, readMemory, writeMemory } from '../plugins/slate/scripts/lib/session.mjs';
import { acquire } from '../plugins/slate/scripts/lib/lock.mjs';
import { MEMORY_FILES } from '../plugins/slate/scripts/lib/items.mjs';
import { checkCuratorEdit } from '../plugins/slate/scripts/lib/check.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SHIM = fileURLToPath(new URL('./fixtures/fake-claude-shim.sh', import.meta.url));
const CURATE = fileURLToPath(new URL('../plugins/slate/scripts/curate.mjs', import.meta.url));
const RULES = fileURLToPath(new URL('../plugins/slate/curator-rules.md', import.meta.url));
// Tests must never reach a real claude: drop what resolveClaudeBin would pick up from this shell.
delete process.env.SLATE_CLAUDE_BIN;
delete process.env.CLAUDE_CODE_EXECPATH;
const ENV_KEYS = [...new Set([
  'FAKE_MODE', 'FAKE_RECORD', 'SLATE_CLAUDE_BIN', 'SLATE_TEST_INHERITED',
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
const GOOD_INSTRUCTIONS = `${INSTRUCTIONS}- [I3 t2] fake item\n`;
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
  const m = /^(\S+) t(\d+) (ok|retry|restored|error): (.*)$/.exec(line);
  assert.ok(m, `bad log line: ${line}`);
  assert.ok(!Number.isNaN(Date.parse(m[1])), `bad timestamp: ${m[1]}`);
  assert.equal(new Date(m[1]).toISOString(), m[1]);
  assert.equal(Number(m[2]), TURN);
  assert.equal(m[3], status);
  return m[4];
}
const lockGone = async (dir) => !(await exists(path.join(dir, 'curator.lock')));
const flag = (args, name) => args[args.indexOf(name) + 1];

test('command: prompt first, every flag, path-scoped rules, env, cwd, stdin ignored', async () => {
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
  assert.equal(flag(args, '--tools'), 'Read,Edit,Write');

  const real = realpathSync(dir);
  if (process.platform === 'darwin') assert.notEqual(real, dir, 'tmpdir goes through a symlink on macOS');
  const rules = MEMORY_FILES.flatMap((f) => [`Read(/${path.join(real, f)})`, `Edit(/${path.join(real, f)})`]);
  // --allowedTools is variadic, so it comes last and takes exactly the ten rules.
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), rules);
  for (const rule of rules) assert.match(rule, /^(Read|Edit)\(\/\/.+\.md\)$/);
  assert.ok(args.indexOf('--tools') < args.indexOf('--allowedTools'));

  assert.equal(env.SLATE_CURATOR, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(env.SLATE_TEST_INHERITED, 'yes');
  assert.equal(call.cwd, realpathSync(root));
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
  assert.ok(prompt.includes('Adopted plain bullets get `t0`.'), 'adoption tag');
  assert.ok(prompt.includes(message), 'message verbatim');
  assert.ok(prompt.includes('a'.repeat(12000)), 'answer kept up to the cap');
  assert.ok(!prompt.includes('ANSWER_TAIL'), 'answer capped');
  assert.ok(prompt.includes('[answer truncated]'));
  const real = realpathSync(dir);
  for (const f of MEMORY_FILES) assert.ok(prompt.includes(path.join(real, f)), f);
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
  const turnFile = path.join(realpathSync(dir), 'conversation', '0002.md');
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

test('good: keeps the edit, logs ok, releases the lock', async () => {
  const { dir, record, before } = await setup('good');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: true, attempts: 1, violations: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], GOOD_INSTRUCTIONS);
  for (const f of MEMORY_FILES) if (f !== 'instructions.md') assert.equal(now[f], before[f], f);
  const log = await logLines(dir);
  assert.equal(log.length, 1);
  assertLog(log[0], 'ok');
  assert.equal((await calls(record)).length, 1);
  assert.ok(await lockGone(dir));
});

test('bad: retries once, then restores the snapshot byte for byte and logs restored', async () => {
  const { dir, record, before } = await setup('bad');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: false, attempts: 2, violations: ['I1 reworded'] });
  assert.deepEqual(await readMemory(dir), before);
  const log = await logLines(dir);
  assert.equal(log.length, 2);
  assert.match(assertLog(log[0], 'retry'), /I1 reworded/);
  assert.match(assertLog(log[1], 'restored'), /I1 reworded/);
  assert.equal((await calls(record)).length, 2);
  assert.ok(await lockGone(dir));
});

test('bad-then-good: keeps the second attempt; its prompt carries the first violations', async () => {
  const { dir, record } = await setup('bad-then-good');
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.deepEqual(r, { ok: true, attempts: 2, violations: [] });
  // I1 is intact, so the first (reworded) edit was undone before the retry.
  assert.equal((await readMemory(dir))['instructions.md'], GOOD_INSTRUCTIONS);
  const [first, second] = await calls(record);
  assert.ok(!first.prompt.includes('rejected'));
  assert.ok(second.prompt.endsWith('Your previous edit was rejected and undone: I1 reworded. Fix and retry.'));
  assert.ok(second.prompt.startsWith(first.prompt));
  const log = await logLines(dir);
  assert.equal(log.length, 2);
  assert.match(assertLog(log[0], 'retry'), /I1 reworded/);
  assertLog(log[1], 'ok');
  assert.ok(await lockGone(dir));
});

for (const [name, mode, bin] of [
  ['fail (edits, then exits 1)', 'fail', FAKE],
  ['a binary that does not exist', 'good', '/nonexistent/slate-claude'],
]) {
  test(`${name}: logs error, leaves files unchanged, releases the lock, does not throw`, async () => {
    const { dir, before } = await setup(mode);
    const r = await runCurator({ dir, turn: TURN, bin });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 1);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /^error: /);
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
  assert.deepEqual(r, { ok: false, attempts: 1, violations: ['error: timeout'] });
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
  assert.deepEqual(r, { ok: false, attempts: 1, violations: ['error: timeout'] });
  assert.ok(await lockGone(dir));
  await new Promise((res) => setTimeout(res, 3000)); // the fake would have edited by now
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

test('restore is byte for byte and keeps an absent file absent', async () => {
  const { dir } = await setup('fail');
  const odd = Buffer.concat([
    Buffer.from('﻿# Instructions\r\n- [I1 t1] use npm\r\n- caf'), Buffer.from([0xff]), Buffer.from('\r\n'),
  ]);
  await fs.writeFile(path.join(dir, 'instructions.md'), odd);
  await fs.rm(path.join(dir, 'now.md'));
  const r = await runCurator({ dir, turn: TURN, bin: FAKE });
  assert.equal(r.ok, false);
  assert.ok((await fs.readFile(path.join(dir, 'instructions.md'))).equals(odd));
  assert.ok(!(await exists(path.join(dir, 'now.md'))), 'now.md stays absent');
});

test('lock held: returns without running and without logging', async () => {
  const { dir, record, before } = await setup('good');
  const release = await acquire(dir);
  try {
    const r = await runCurator({ dir, turn: TURN, bin: FAKE });
    assert.deepEqual(r, { ok: false, attempts: 0, violations: ['locked'] });
    assert.deepEqual(await calls(record), []);
    assert.deepEqual(await logLines(dir), []);
    assert.deepEqual(await readMemory(dir), before);
    assert.ok(!(await lockGone(dir)), 'the holder keeps its lock');
  } finally {
    await release();
  }
});

test("curator-rules.md: the worked example passes the safety check", async () => {
  const rules = await fs.readFile(RULES, 'utf8');
  const old = '- [I1 t1] use npm';
  const added = '- [I2 t4] use pnpm';
  const retired = '- [I1 t1 retired t4] use npm (reason: user switched to pnpm)';
  for (const line of [old, added, retired]) assert.ok(rules.includes(`\n${line}\n`), line);
  const empty = { 'assumptions.md': '# Assumptions\n', 'facts.md': '# Facts\n', 'now.md': '' };
  const before = { ...empty, 'instructions.md': `# Instructions\n${old}\n`, 'superseded.md': '# Superseded\n' };
  const afterEdit = {
    ...empty,
    'instructions.md': `# Instructions\n${added}\n`,
    'superseded.md': `# Superseded\n${retired}\n`,
  };
  assert.deepEqual(checkCuratorEdit(before, afterEdit, 4), []);
});

test('curator-rules.md: wording the curator relies on', async () => {
  const rules = await fs.readFile(RULES, 'utf8');
  for (const s of [
    "Every item line you don't retire stays exactly as it is.",
    'To retire a plain user bullet (no ID), adopt it as `- [<ID> t0] <exact text>` and retire that ID in the same edit.',
    '"use the staging DB for this"',
    'If `now.md` is over 10 lines, shorten it.',
  ]) assert.ok(rules.includes(s), s);
});

test('retiring a plain user bullet by adopting it at t0 passes the safety check', () => {
  const empty = { 'assumptions.md': '# Assumptions\n', 'facts.md': '# Facts\n', 'now.md': '' };
  const before = {
    ...empty, 'instructions.md': '# Instructions\n- [I1 t1] use npm\n- prefer tabs\n', 'superseded.md': '# Superseded\n',
  };
  const afterEdit = {
    ...empty,
    'instructions.md': '# Instructions\n- [I1 t1] use npm\n- [I3 t2] use spaces\n',
    'superseded.md': '# Superseded\n- [I2 t0 retired t2] prefer tabs (reason: user switched to spaces)\n',
  };
  assert.deepEqual(checkCuratorEdit(before, afterEdit, 2), []);
});

test('CLI: node curate.mjs <dir> <turn> [model]', async () => {
  const { dir, record } = await setup('good');
  await promisify(execFile)(process.execPath, [CURATE, dir, String(TURN), 'haiku'], {
    env: { ...process.env, SLATE_CLAUDE_BIN: FAKE },
  });
  assert.equal((await readMemory(dir))['instructions.md'], GOOD_INSTRUCTIONS);
  const [call] = await calls(record);
  assert.equal(flag(call.args, '--model'), 'haiku');
  assertLog((await logLines(dir))[0], 'ok');
});
