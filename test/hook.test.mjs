import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../plugins/slate/scripts/hook.mjs';
import { initSession, readSession, readTurn, sessionDir } from '../plugins/slate/scripts/lib/session.mjs';
import { acquire } from '../plugins/slate/scripts/lib/lock.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../plugins/slate/scripts/hook.mjs', import.meta.url));
const CURATE = fileURLToPath(new URL('../plugins/slate/scripts/curate.mjs', import.meta.url));
const HOOKS_JSON = new URL('../plugins/slate/hooks/hooks.json', import.meta.url);
const REMINDER = 'slate: offload heavy reads to slate:offload; reply briefly.';
const COMPACT_LINE = 'Memory below wins where it differs from the summary.';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact'];

// Tests must never reach a real claude, nor a real project's .slate/.
for (const k of ['SLATE_CLAUDE_BIN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PID', 'SLATE_CURATOR',
  'SLATE_WAIT_MS', 'CLAUDE_PLUGIN_OPTION_CURATORMODEL', 'FAKE_MODE', 'FAKE_RECORD']) delete process.env[k];

const temps = [];
const NO_CLAUDE = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-noclaude-'));
temps.push(NO_CLAUDE);
await fs.writeFile(path.join(NO_CLAUDE, 'claude'), '#!/bin/sh\necho "test reached claude on PATH" >&2\nexit 97\n', {
  mode: 0o755,
});
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});

const PID = 424242;

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-hook-'));
  temps.push(root);
  const env = {
    ...process.env,
    PATH: `${NO_CLAUDE}${path.delimiter}${process.env.PATH}`,
    SLATE_CLAUDE_BIN: FAKE,
    FAKE_MODE: 'good',
    CLAUDE_PID: String(PID),
  };
  return { root, env };
}

async function activeSession(id = 'sid') {
  const p = await project();
  const { dir } = await initSession(p.root, id, PID);
  return { ...p, dir, id };
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const ctx = (r) => r.output?.hookSpecificOutput?.additionalContext;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logLines(dir) {
  try {
    return (await fs.readFile(path.join(dir, 'curator.log'), 'utf8')).split('\n').filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Waits until curator.log has `n` lines and the curator released its lock.
async function waitLog(dir, n, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const lines = await logLines(dir);
    if (lines.length >= n && !(await exists(path.join(dir, 'curator.lock')))) return lines;
    if (Date.now() > deadline) assert.fail(`curator.log has ${lines.length} lines, wanted ${n}`);
    await sleep(50);
  }
}

const prompt = (id, root, text) => ({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: root, prompt: text });
const stop = (id, root, text) => ({ hook_event_name: 'Stop', session_id: id, cwd: root, last_assistant_message: text });
const start = (id, root, source) => ({ hook_event_name: 'SessionStart', session_id: id, cwd: root, source });
const input = (event, id, root) => ({
  SessionStart: start(id, root, 'resume'),
  UserPromptSubmit: prompt(id, root, 'hi'),
  Stop: stop(id, root, 'hello'),
  PreCompact: { hook_event_name: 'PreCompact', session_id: id, cwd: root, trigger: 'auto' },
})[event];

// --- guards ---

test('no folder: every event gives null and creates nothing', async () => {
  const { root, env } = await project();
  for (const event of EVENTS) {
    const r = await handle(event, input(event, 'sid', root), env);
    assert.equal(r.output, null, event);
    assert.equal(r.spawned, undefined, event);
  }
  for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    assert.equal((await handle('SessionStart', start('sid', root, source), env)).output, null, source);
  }
  assert.equal(await exists(path.join(root, '.slate')), false);
});

test('SLATE_CURATOR=1: null for every event, even with a folder, and nothing changes', async () => {
  const { root, env, dir, id } = await activeSession();
  env.SLATE_CURATOR = '1';
  for (const event of EVENTS) {
    const r = await handle(event, input(event, id, root), env);
    assert.equal(r.output, null, event);
    assert.equal(r.spawned, undefined, event);
  }
  assert.equal((await readSession(dir)).turn, 0);
  assert.equal(await exists(path.join(dir, 'conversation', '0001.md')), false);
});

test('agent_id: hooks fired inside a subagent are no-ops', async () => {
  const { root, env, dir, id } = await activeSession();
  for (const event of EVENTS) {
    const r = await handle(event, { ...input(event, id, root), agent_id: 'a1', agent_type: 'slate:offload' }, env);
    assert.equal(r.output, null, event);
    assert.equal(r.spawned, undefined, event);
  }
  const s = await readSession(dir);
  assert.equal(s.turn, 0);
  assert.equal(s.lastKind, undefined);
});

// --- UserPromptSubmit ---

test('UserPromptSubmit: writes conversation/0001.md verbatim and injects the change line', async () => {
  const { root, env, dir, id } = await activeSession();
  const text = 'use pnpm\n<!-- slate:answer -->\n  keep `$HOME` and "quotes"';
  const r = await handle('UserPromptSubmit', prompt(id, root, text), env);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(ctx(r).startsWith(REMINDER));
  const s = await readSession(dir);
  assert.equal(s.turn, 1);
  assert.equal(s.lastKind, 'user');
  assert.equal((await readTurn(dir, 1)).message, text);
  const raw = await fs.readFile(path.join(dir, 'conversation', '0001.md'), 'utf8');
  const at = /^# Turn 1 \((.+)\)$/m.exec(raw)?.[1];
  assert.equal(new Date(at).toISOString(), at, 'ISO timestamp');
});

test('Review Focus 4: a 15k prompt is stored in full; additionalContext stays ≤10,000 without it', async () => {
  const { root, env, dir, id } = await activeSession();
  const text = Array.from({ length: 1100 }, (_, i) => `p${String(i).padStart(4, '0')}-xxxxxxxx`).join(' ');
  assert.ok(text.length >= 15000);
  const r = await handle('UserPromptSubmit', prompt(id, root, text), env);
  assert.equal((await readTurn(dir, 1)).message, text);
  assert.ok(ctx(r).length <= 10000);
  assert.ok(!ctx(r).includes('p0500-xxxxxxxx'));
  assert.ok(!ctx(r).includes(text.slice(0, 40)));
});

test('Review Focus 1: a held lock gives "memory still updating"; after the curator, +I…', async () => {
  const { root, env, dir, id } = await activeSession();
  env.SLATE_WAIT_MS = '200';
  const release = await acquire(dir); // held by this live test process
  const t0 = Date.now();
  const r1 = await handle('UserPromptSubmit', prompt(id, root, 'remember: use pnpm'), env);
  assert.ok(Date.now() - t0 >= 200, 'waited for the lock');
  assert.ok(Date.now() - t0 < 5000, 'gave up after SLATE_WAIT_MS');
  assert.match(ctx(r1), /memory still updating/);
  assert.equal((await readSession(dir)).turn, 1, 'the turn is still recorded');
  await release();

  await handle('Stop', stop(id, root, 'ok, pnpm'), env);
  await waitLog(dir, 1);
  const r2 = await handle('UserPromptSubmit', prompt(id, root, 'next'), env);
  assert.match(ctx(r2), /\+I1 fake item/);
  assert.doesNotMatch(ctx(r2), /memory still updating/);
});

test('/slate:init prompt: no turn, no output; the following Stop does nothing', async () => {
  const { root, env, dir, id } = await activeSession();
  const r = await handle('UserPromptSubmit', prompt(id, root, '/slate:init'), env);
  assert.equal(r.output, null);
  const s = await readSession(dir);
  assert.equal(s.turn, 0);
  assert.equal(s.lastKind, 'slate');
  const st = await handle('Stop', stop(id, root, 'slate is active'), env);
  assert.equal(st.output, null);
  assert.equal(st.spawned, undefined);
  assert.deepEqual(await fs.readdir(path.join(dir, 'conversation')), []);
});

test('notification prompt: no new turn; the next Stop appends a continuation and curates the same turn', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('UserPromptSubmit', prompt(id, root, 'run the offload agent'), env);
  const s1 = await handle('Stop', stop(id, root, 'running in the background'), env);
  assert.deepEqual(s1.spawned, [CURATE, dir, '1', 'sonnet']);
  await waitLog(dir, 1);

  const n = await handle('UserPromptSubmit', prompt(id, root, '<task-notification>\n<status>completed</status>'), env);
  assert.ok(ctx(n).startsWith(REMINDER));
  assert.equal(n.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  let s = await readSession(dir);
  assert.equal(s.turn, 1);
  assert.equal(s.lastKind, 'notification');
  assert.deepEqual(await fs.readdir(path.join(dir, 'conversation')), ['0001.md']);

  const s2 = await handle('Stop', stop(id, root, 'the real answer'), env);
  assert.deepEqual(s2.spawned, [CURATE, dir, '1', 'sonnet']);
  const t = await readTurn(dir, 1);
  assert.equal(t.message, 'run the offload agent');
  assert.equal(t.answer, 'running in the background\n\nthe real answer');
  const log = await waitLog(dir, 2);
  assert.match(log[1], / t1 ok: /);
  s = await readSession(dir);
  assert.equal(s.turn, 1);
});

test('notification before any user turn: change line only; the Stop does nothing', async () => {
  const { root, env, dir, id } = await activeSession();
  const n = await handle('UserPromptSubmit', prompt(id, root, '<task-notification>x'), env);
  assert.ok(ctx(n).startsWith(REMINDER));
  const st = await handle('Stop', stop(id, root, 'answer'), env);
  assert.equal(st.spawned, undefined);
  assert.equal((await readSession(dir)).turn, 0);
  assert.deepEqual(await fs.readdir(path.join(dir, 'conversation')), []);
});

// --- Stop ---

test('Stop: appends the answer, spawns the curator detached, returns within 1s; curator logs ok', async () => {
  const { root, env, dir, id } = await activeSession();
  env.FAKE_MODE = 'sleep';
  env.CLAUDE_PLUGIN_OPTION_CURATORMODEL = 'haiku';
  await handle('UserPromptSubmit', prompt(id, root, 'switch to pnpm'), env);
  const t0 = Date.now();
  const r = await handle('Stop', stop(id, root, 'Done, using pnpm.'), env);
  assert.ok(Date.now() - t0 < 1000, `Stop took ${Date.now() - t0}ms`);
  assert.equal(r.output, null);
  assert.deepEqual(r.spawned, [CURATE, dir, '1', 'haiku']);
  assert.equal((await readTurn(dir, 1)).answer, 'Done, using pnpm.');
  assert.equal((await logLines(dir)).length, 0, 'curator still running');
  const [line] = await waitLog(dir, 1);
  assert.match(line, / t1 ok: /);
});

test('Stop before any turn: nothing', async () => {
  const { root, env, dir, id } = await activeSession();
  const r = await handle('Stop', stop(id, root, 'hello'), env);
  assert.equal(r.output, null);
  assert.equal(r.spawned, undefined);
  assert.deepEqual(await fs.readdir(path.join(dir, 'conversation')), []);
});

// --- PreCompact ---

test('PreCompact: waits for a running curator, then gives no output', async () => {
  const { root, env, dir, id } = await activeSession();
  const release = await acquire(dir);
  setTimeout(release, 300);
  const t0 = Date.now();
  const r = await handle('PreCompact', input('PreCompact', id, root), env);
  assert.ok(Date.now() - t0 >= 250, 'waited');
  assert.equal(r.output, null);
});

// --- SessionStart ---

test('SessionStart clear: moves the folder found by pid to the new ID and injects the block', async () => {
  const { root, env, dir: old } = await activeSession('old');
  const r = await handle('SessionStart', start('new', root, 'clear'), env);
  const dir = sessionDir(root, 'new');
  assert.equal(await exists(old), false);
  const s = await readSession(dir);
  assert.equal(s.from, 'old');
  assert.equal(s.pid, PID);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx(r).startsWith('# slate memory'));
  assert.ok(!ctx(r).includes(COMPACT_LINE));
  assert.ok(ctx(r).includes(dir), 'rules point at the new folder');
});

test('SessionStart clear: a folder with another pid is left alone', async () => {
  const { root, env, dir: old } = await activeSession('old');
  env.CLAUDE_PID = '777';
  const r = await handle('SessionStart', start('new', root, 'clear'), env);
  assert.equal(r.output, null);
  assert.ok(await exists(old));
  assert.equal(await exists(sessionDir(root, 'new')), false);
});

test('SessionStart compact: the block carries the summary line', async () => {
  const { root, env, id } = await activeSession();
  const r = await handle('SessionStart', start(id, root, 'compact'), env);
  assert.ok(ctx(r).startsWith(`# slate memory\n${COMPACT_LINE}`));
  assert.ok(ctx(r).length <= 10000);
});

test('SessionStart resume: rewrites the pid and injects the block', async () => {
  const { root, env, dir, id } = await activeSession();
  env.CLAUDE_PID = '5150';
  const r = await handle('SessionStart', start(id, root, 'resume'), env);
  assert.equal((await readSession(dir)).pid, 5150);
  assert.ok(ctx(r).startsWith('# slate memory'));
  assert.ok(!ctx(r).includes(COMPACT_LINE));
});

test('SessionStart fork: a pid match copies the folder; the parent stays', async () => {
  const { root, env, dir: parent } = await activeSession('parent');
  const r = await handle('SessionStart', start('child', root, 'fork'), env);
  const dir = sessionDir(root, 'child');
  const s = await readSession(dir);
  assert.equal(s.from, 'parent');
  assert.equal(s.pid, PID);
  assert.ok(await exists(parent));
  assert.ok(ctx(r).startsWith('# slate memory'));
});

test('SessionStart fork: no pid match does nothing', async () => {
  const { root, env, dir: parent } = await activeSession('parent');
  env.CLAUDE_PID = '9999';
  const r = await handle('SessionStart', start('child', root, 'fork'), env);
  assert.equal(r.output, null);
  assert.equal(await exists(sessionDir(root, 'child')), false);
  assert.ok(await exists(parent));
});

test('SessionStart startup with no folder: nothing, even when another folder has this pid', async () => {
  const { root, env, dir: other } = await activeSession('other');
  const r = await handle('SessionStart', start('new', root, 'startup'), env);
  assert.equal(r.output, null);
  assert.ok(await exists(other));
  assert.equal(await exists(sessionDir(root, 'new')), false);
});

test('CLAUDE_PROJECT_DIR wins over the input cwd', async () => {
  const { root, env, dir, id } = await activeSession();
  env.CLAUDE_PROJECT_DIR = root;
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-cwd-'));
  temps.push(elsewhere);
  const r = await handle('UserPromptSubmit', prompt(id, elsewhere, 'hi'), env);
  assert.ok(ctx(r).startsWith(REMINDER));
  assert.equal((await readSession(dir)).turn, 1);
});

// --- CLI ---

function run(event, stdin, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK, event], { env, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

test('CLI: UserPromptSubmit prints hook JSON; Stop exits 0 silently and the curator runs', async () => {
  const { root, env, dir, id } = await activeSession();
  const u = await run('UserPromptSubmit', JSON.stringify(prompt(id, root, 'hi')), env);
  assert.equal(u.code, 0);
  assert.equal(u.stderr, '');
  const out = JSON.parse(u.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(REMINDER));

  const s = await run('Stop', JSON.stringify(stop(id, root, 'hello')), env);
  assert.deepEqual(s, { code: 0, stdout: '', stderr: '' });
  assert.equal((await readTurn(dir, 1)).answer, 'hello');
  const [line] = await waitLog(dir, 1);
  assert.match(line, / t1 ok: /);
});

test('CLI: no folder exits 0 with no output', async () => {
  const { root, env } = await project();
  for (const event of EVENTS) {
    const r = await run(event, JSON.stringify(input(event, 'sid', root)), env);
    assert.deepEqual(r, { code: 0, stdout: '', stderr: '' }, event);
  }
});

test('CLI: bad input exits 0 with one stderr line and no stdout', async () => {
  const { env } = await project();
  const r = await run('Stop', 'not json', env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1);
  assert.ok(r.stderr.endsWith('\n'));
});

// --- hooks.json ---

test('hooks.json: four events, matcher, timeouts, quoted plugin-root commands', async () => {
  const cfg = JSON.parse(await fs.readFile(HOOKS_JSON, 'utf8'));
  assert.deepEqual(Object.keys(cfg), ['hooks']);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), [...EVENTS].sort());
  const want = { SessionStart: 60, UserPromptSubmit: 30, Stop: 10, PreCompact: 90 };
  for (const event of EVENTS) {
    const groups = cfg.hooks[event];
    assert.equal(groups.length, 1, event);
    const [group] = groups;
    if (event === 'SessionStart') assert.equal(group.matcher, 'startup|resume|clear|compact|fork');
    else assert.equal(group.matcher, undefined, event);
    assert.deepEqual(group.hooks, [{
      type: 'command',
      command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" ${event}`,
      timeout: want[event],
    }], event);
  }
  const root = fileURLToPath(new URL('../plugins/slate/', import.meta.url));
  assert.ok(await exists(path.join(root, 'scripts', 'hook.mjs')));
});
