import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, curatorWaitMs, HARNESS_PREFIXES, HANDBACK_TOOLS } from '../plugins/slate/scripts/hook.mjs';
import { initSession, readSession, readTurn, readMemory, sessionDir, appendAnswer } from '../plugins/slate/scripts/lib/session.mjs';
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
const lockOf = (dir) => path.join(dir, 'curator.lock');
const logTurns = async (dir) => (await logLines(dir)).map((l) => / (t\d+ \w+):/.exec(l)[1]);

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) assert.fail('timed out');
    await sleep(25);
  }
}

async function fakeCalls(file) {
  return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

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
  env.CLAUDE_PID = '1'; // a resume that ran would rewrite the pid
  for (const event of EVENTS) {
    const r = await handle(event, input(event, id, root), env);
    assert.equal(r.output, null, event);
    assert.equal(r.spawned, undefined, event);
  }
  const s = await readSession(dir);
  assert.equal(s.turn, 0);
  assert.equal(s.pid, PID);
  assert.equal(await exists(path.join(dir, 'queue', '0001.md')), false);
});

test('agent_id: hooks fired inside a subagent are no-ops', async () => {
  const { root, env, dir, id } = await activeSession();
  env.CLAUDE_PID = '1';
  for (const event of EVENTS) {
    const r = await handle(event, { ...input(event, id, root), agent_id: 'a1', agent_type: 'slate:offload' }, env);
    assert.equal(r.output, null, event);
    assert.equal(r.spawned, undefined, event);
  }
  const s = await readSession(dir);
  assert.equal(s.turn, 0);
  assert.equal(s.pid, PID);
  assert.equal(s.lastKind, undefined);
});

// --- UserPromptSubmit ---

test('UserPromptSubmit: writes queue/0001.md verbatim and injects the change line', async () => {
  const { root, env, dir, id } = await activeSession();
  const text = 'use pnpm\n<!-- slate:answer -->\n  keep `$HOME` and "quotes"';
  const r = await handle('UserPromptSubmit', prompt(id, root, text), env);
  assert.equal(r.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(ctx(r).startsWith(REMINDER));
  const s = await readSession(dir);
  assert.equal(s.turn, 1);
  assert.equal(s.lastKind, 'user');
  assert.equal((await readTurn(dir, 1)).message, text);
  const raw = await fs.readFile(path.join(dir, 'queue', '0001.md'), 'utf8');
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
  assert.deepEqual(await fs.readdir(path.join(dir, 'queue')), []);
});

test('notification while curator A runs: no new turn; the continuation is curated after A, same turn', async () => {
  const { root, env, dir, id } = await activeSession();
  env.FAKE_MODE = 'sleep';
  env.FAKE_SLEEP_MS = '1000';
  env.FAKE_RECORD = path.join(root, 'record.jsonl');
  await handle('UserPromptSubmit', prompt(id, root, 'run the offload agent'), env);
  const s1 = await handle('Stop', stop(id, root, 'running in the background'), env);
  assert.deepEqual(s1.spawned, [CURATE, dir, '1', 'sonnet']);
  await until(() => exists(lockOf(dir))); // curator A is running

  const n = await handle('UserPromptSubmit', prompt(id, root, '<task-notification>\n<status>completed</status>'), env);
  assert.equal(n.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(ctx(n).startsWith(REMINDER));
  assert.match(ctx(n), /memory still updating/);
  let s = await readSession(dir);
  assert.equal(s.turn, 1);
  assert.equal(s.lastKind, 'notification');
  assert.deepEqual(await fs.readdir(path.join(dir, 'queue')), ['0001.md']);

  const s2 = await handle('Stop', stop(id, root, 'the real answer'), env);
  assert.deepEqual(s2.spawned, [CURATE, dir, '1', 'sonnet']);
  assert.ok(await exists(lockOf(dir)), 'curator B starts while A still holds the lock');
  const t = await readTurn(dir, 1);
  assert.equal(t.message, 'run the offload agent');
  assert.equal(t.answer, 'running in the background\n\nthe real answer');

  await waitLog(dir, 2);
  assert.deepEqual(await logTurns(dir), ['t1 ok', 't1 ok']);
  const [first, second, ...rest] = await fakeCalls(env.FAKE_RECORD);
  assert.deepEqual(rest, []);
  assert.ok(!first.prompt.includes('the real answer'));
  assert.ok(second.prompt.includes('running in the background\n\nthe real answer'));
  s = await readSession(dir);
  assert.equal(s.turn, 1);
});

test('HARNESS_PREFIXES: the five harness message shapes', () => {
  assert.deepEqual(HARNESS_PREFIXES, [
    '<task-notification', '<agent-message', '<cross-session-message', '<teammate-message', '[SYSTEM NOTIFICATION',
  ]);
});

for (const prefix of [
  '<task-notification', '<agent-message', '<cross-session-message', '<teammate-message', '[SYSTEM NOTIFICATION',
]) {
  test(`harness message ${prefix}: not a turn, no queue file, change line injected`, async () => {
    const { root, env, dir, id } = await activeSession();
    const text = `${prefix} from="a1">\n  report text that must not be recorded as the user's\n`;
    const n = await handle('UserPromptSubmit', prompt(id, root, text), env);
    assert.ok(ctx(n).startsWith(REMINDER));
    const s = await readSession(dir);
    assert.equal(s.turn, 0);
    assert.equal(s.lastKind, 'notification');
    assert.deepEqual(await fs.readdir(path.join(dir, 'queue')), []);
  });
}

test('<agent-message> after a user turn: the following Stop appends a continuation to that turn', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('UserPromptSubmit', prompt(id, root, 'find the TODOs'), env);
  await handle('Stop', stop(id, root, 'running in the background'), env);
  const n = await handle('UserPromptSubmit', prompt(id, root, '<agent-message from="a1">\n  Found 12.\n</agent-message>'), env);
  assert.ok(ctx(n).startsWith(REMINDER));
  const s2 = await handle('Stop', stop(id, root, '12 files.'), env);
  assert.deepEqual(s2.spawned, [CURATE, dir, '1', 'sonnet']);
  const t = await readTurn(dir, 1);
  assert.equal(t.message, 'find the TODOs');
  assert.equal(t.answer, 'running in the background\n\n12 files.');
  assert.equal((await readSession(dir)).turn, 1);
  await until(async () => !(await exists(lockOf(dir))) && (await logLines(dir)).length >= 1);
  await until(async () => !(await exists(lockOf(dir))));
});

test('notification before any user turn: change line only; the Stop does nothing', async () => {
  const { root, env, dir, id } = await activeSession();
  const n = await handle('UserPromptSubmit', prompt(id, root, '<task-notification>x'), env);
  assert.ok(ctx(n).startsWith(REMINDER));
  const st = await handle('Stop', stop(id, root, 'answer'), env);
  assert.equal(st.spawned, undefined);
  assert.equal((await readSession(dir)).turn, 0);
  assert.deepEqual(await fs.readdir(path.join(dir, 'queue')), []);
});

// --- SubagentStop ---

const subStop = (id, root, fields = {}) => ({
  hook_event_name: 'SubagentStop', session_id: id, cwd: root, agent_id: 'a1', agent_type: 'slate:offload',
  stop_hook_active: false, last_assistant_message: 'x'.repeat(801), ...fields,
});
const BLOCK_801 = {
  decision: 'block',
  reason: 'Return is 801 chars. Rewrite it in ≤600 chars, ≤10 lines; details belong in the report.',
};

test('SubagentStop: a slate:offload return over 800 chars is blocked once with its length', async () => {
  const { root, env, dir, id } = await activeSession();
  const before = await fs.readFile(path.join(dir, 'session.json'), 'utf8');
  const r = await handle('SubagentStop', subStop(id, root), env);
  assert.deepEqual(r.output, BLOCK_801);
  assert.equal(r.spawned, undefined);
  assert.equal(await fs.readFile(path.join(dir, 'session.json'), 'utf8'), before, 'session untouched');
  // The rewrite stops with stop_hook_active set: never blocked twice.
  const again = await handle('SubagentStop', subStop(id, root, { stop_hook_active: true }), env);
  assert.equal(again.output, null);
});

test('SubagentStop: length counts characters, not UTF-16 units', async () => {
  const { root, env, id } = await activeSession();
  const r = await handle('SubagentStop', subStop(id, root, { last_assistant_message: '≤'.repeat(800) + '😀' }), env);
  assert.equal(r.output.reason, 'Return is 801 chars. Rewrite it in ≤600 chars, ≤10 lines; details belong in the report.');
  const ok = await handle('SubagentStop', subStop(id, root, { last_assistant_message: '😀'.repeat(800) }), env);
  assert.equal(ok.output, null);
});

test('SubagentStop: nothing for ≤800 chars, other agents, no folder, or inside the curator', async () => {
  const { root, env, id } = await activeSession();
  const cases = [
    subStop(id, root, { last_assistant_message: 'x'.repeat(800) }),
    subStop(id, root, { agent_type: 'Explore' }),
    subStop(id, root, { agent_type: '' }),
    subStop(id, root, { agent_type: undefined }),
    subStop(id, root, { last_assistant_message: undefined }),
    subStop('other-session', root),
  ];
  for (const c of cases) assert.equal((await handle('SubagentStop', c, env)).output, null, JSON.stringify(c).slice(0, 120));
  assert.equal((await handle('SubagentStop', subStop(id, root), { ...env, SLATE_CURATOR: '1' })).output, null);
  const bare = await project();
  assert.equal((await handle('SubagentStop', subStop('sid', bare.root), bare.env)).output, null);
  assert.equal(await exists(path.join(bare.root, '.slate')), false);
});

test('CLI: SubagentStop prints the block JSON', async () => {
  const { root, env, id } = await activeSession();
  const r = await run('SubagentStop', JSON.stringify(subStop(id, root)), env);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), BLOCK_801);
});

// --- SubagentStop (offload index) ---

const offloadsOf = (dir) => fs.readFile(path.join(dir, 'offloads.md'), 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
const ENTRY_HEAD = /^## t(\d+) (\S+) (\S+)\ntranscript: (.*)\n\n/gm;
const entries = async (dir) => [...((await offloadsOf(dir)) ?? '').matchAll(ENTRY_HEAD)]
  .map((m) => ({ turn: Number(m[1]), at: m[2], agent: m[3], transcript: m[4] }));

test('SubagentStop: a short slate:offload return is recorded with turn, agent, transcript and text', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('UserPromptSubmit', prompt(id, root, 'find the callers'), env);
  const r = await handle('SubagentStop', subStop(id, root, {
    agent_id: 'a9f', agent_transcript_path: '/home/u/.claude/projects/p/s/subagents/agent-a9f.jsonl',
    last_assistant_message: 'Found 3 callers.\nReport: reports/callers.md',
  }), env);
  assert.equal(r.output, null);
  const [e, ...rest] = await entries(dir);
  assert.deepEqual(rest, []);
  assert.deepEqual({ ...e, at: undefined }, {
    turn: 1, at: undefined, agent: 'a9f', transcript: '/home/u/.claude/projects/p/s/subagents/agent-a9f.jsonl',
  });
  assert.ok(!Number.isNaN(Date.parse(e.at)), e.at);
  assert.ok((await offloadsOf(dir)).includes('\n> Found 3 callers.\n> Report: reports/callers.md\n'));
});

test('SubagentStop: a blocked return writes no entry; the rewrite that passes does', async () => {
  const { root, env, dir, id } = await activeSession();
  const blocked = await handle('SubagentStop', subStop(id, root), env);
  assert.deepEqual(blocked.output, BLOCK_801);
  assert.equal(await offloadsOf(dir), null);
  await handle('SubagentStop', subStop(id, root, { stop_hook_active: true, last_assistant_message: 'short now' }), env);
  assert.equal((await entries(dir)).length, 1);
  assert.ok((await offloadsOf(dir)).includes('> short now\n'));
});

test('SubagentStop: other agents, no folder and unsafe agent IDs write no entry', async () => {
  const { root, env, dir, id } = await activeSession();
  for (const f of [{ agent_type: 'Explore' }, { agent_type: '' }, { agent_type: undefined }, { agent_id: '../x' },
    { agent_id: undefined }, { agent_id: 42 }]) {
    await handle('SubagentStop', subStop(id, root, { last_assistant_message: 'ok', ...f }), env);
  }
  assert.equal(await offloadsOf(dir), null);
  const bare = await project();
  await handle('SubagentStop', subStop('sid', bare.root, { last_assistant_message: 'ok' }), bare.env);
  assert.equal(await exists(path.join(bare.root, '.slate')), false);
});

test('SubagentStop: no agent_transcript_path is written as none', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('SubagentStop', subStop(id, root, { last_assistant_message: 'ok' }), env);
  assert.equal((await entries(dir))[0].transcript, 'none');
});

test('hand-back: the message PreToolUse lets through is the entry text', async () => {
  const { root, env, dir, id } = await activeSession();
  const agent = 'a435d85d2980fd4d2';
  assert.equal((await handle('PreToolUse', handback(id, root, { tool_input: { message: 'Handed back: 2 bugs.' } }), env)).output, null);
  await handle('SubagentStop', subStop(id, root, { agent_id: agent, last_assistant_message: undefined }), env);
  const [e] = await entries(dir);
  assert.equal(e.agent, agent);
  assert.ok((await offloadsOf(dir)).includes('\n> Handed back: 2 bugs.\n'));
});

test('hand-back: denied once, then allowed: the entry holds the allowed message', async () => {
  const { root, env, dir, id } = await activeSession();
  const agent = 'a435d85d2980fd4d2';
  assert.deepEqual((await handle('PreToolUse', handback(id, root), env)).output, DENY_801);
  await handle('PreToolUse', handback(id, root, { tool_input: { message: 'second try' } }), env);
  await handle('SubagentStop', subStop(id, root, { agent_id: agent, last_assistant_message: undefined }), env);
  const text = await offloadsOf(dir);
  assert.ok(text.includes('> second try\n'), text);
  assert.ok(!text.includes('xxxx'));
});

test('hand-back: no saved message and no final text: entry says so', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('SubagentStop', subStop(id, root, { last_assistant_message: undefined }), env);
  assert.ok((await offloadsOf(dir)).includes('> (no return text)\n'));
});

// --- PreToolUse (hand-back cap) ---

const handback = (id, root, fields = {}) => ({
  hook_event_name: 'PreToolUse', session_id: id, cwd: root, agent_id: 'a435d85d2980fd4d2', agent_type: 'slate:offload',
  tool_name: 'SubagentHandback', tool_input: { message: 'x'.repeat(801) }, tool_use_id: 't1', ...fields,
});
const DENY_801 = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Hand-back is 801 chars. Call SubagentHandback again with ≤600 chars, ≤10 lines; details belong in the report.',
  },
};
const marker = (dir, agent = 'a435d85d2980fd4d2') => path.join(dir, 'handbacks', agent);

test('HANDBACK_TOOLS: the hand-back tool', () => {
  assert.deepEqual(HANDBACK_TOOLS, ['SubagentHandback']);
});

test('PreToolUse: an offload hand-back over 800 chars is denied once, then allowed', async () => {
  const { root, env, dir, id } = await activeSession();
  const before = await fs.readFile(path.join(dir, 'session.json'), 'utf8');
  const r = await handle('PreToolUse', handback(id, root), env);
  assert.deepEqual(r.output, DENY_801);
  assert.ok(await exists(marker(dir)), 'marker written');
  const again = await handle('PreToolUse', handback(id, root, { tool_input: { message: 'y'.repeat(2000) } }), env);
  assert.equal(again.output, null, 'second hand-back of the same agent goes through');
  assert.equal(await fs.readFile(path.join(dir, 'session.json'), 'utf8'), before, 'session untouched');
  // A different offload agent gets its own single denial.
  const other = await handle('PreToolUse', handback(id, root, { agent_id: 'b1' }), env);
  assert.deepEqual(other.output, DENY_801);
});

test('PreToolUse: length counts code points; ≤800 passes and writes no marker', async () => {
  const { root, env, dir, id } = await activeSession();
  const ok = await handle('PreToolUse', handback(id, root, { tool_input: { message: '😀'.repeat(800) } }), env);
  assert.equal(ok.output, null);
  assert.equal(await exists(marker(dir)), false);
  const r = await handle('PreToolUse', handback(id, root, { tool_input: { message: '≤'.repeat(800) + '😀' } }), env);
  assert.equal(r.output.hookSpecificOutput.permissionDecisionReason, DENY_801.hookSpecificOutput.permissionDecisionReason);
});

test('PreToolUse: nothing for other agents, other tools, no message, no folder, or inside the curator', async () => {
  const { root, env, dir, id } = await activeSession();
  const cases = [
    handback(id, root, { agent_type: 'Explore' }),
    handback(id, root, { agent_type: undefined, agent_id: undefined }), // the main thread
    handback(id, root, { tool_name: 'Write', tool_input: { message: 'x'.repeat(900), file_path: '/tmp/x' } }),
    handback(id, root, { tool_input: {} }),
    handback(id, root, { tool_input: { message: 42 } }),
    handback('other-session', root),
  ];
  for (const c of cases) assert.equal((await handle('PreToolUse', c, env)).output, null, JSON.stringify(c).slice(0, 140));
  const inCurator = { ...env };
  inCurator.SLATE_CURATOR = '1';
  assert.equal((await handle('PreToolUse', handback(id, root), inCurator)).output, null);
  assert.equal(await exists(path.join(dir, 'handbacks')), false);
  const bare = await project();
  assert.equal((await handle('PreToolUse', handback('sid', bare.root), bare.env)).output, null);
  assert.equal(await exists(path.join(bare.root, '.slate')), false);
});

test('PreToolUse: a bad agent_id is never used as a path; the hand-back is allowed', async () => {
  const { root, env, dir, id } = await activeSession();
  for (const agent of ['../escape', '..', '.', 'a/b', '', 42]) {
    const r = await handle('PreToolUse', handback(id, root, { agent_id: agent }), env);
    assert.equal(r.output, null, String(agent));
  }
  assert.equal(await exists(path.join(dir, 'handbacks')), false);
  assert.equal(await exists(path.join(dir, 'escape')), false);
  assert.equal(await exists(path.join(path.dirname(dir), 'escape')), false);
});

test('CLI: PreToolUse prints the deny JSON once', async () => {
  const { root, env, id } = await activeSession();
  const r = await run('PreToolUse', JSON.stringify(handback(id, root)), env);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), DENY_801);
  const again = await run('PreToolUse', JSON.stringify(handback(id, root)), env);
  assert.deepEqual(again, { code: 0, stdout: '', stderr: '' });
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
  assert.deepEqual(await fs.readdir(path.join(dir, 'queue')), []);
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

test('SessionStart startup with no folder: no output; a folder holding this pid only loses the pid', async () => {
  const { root, env, dir: other } = await activeSession('other');
  const r = await handle('SessionStart', start('new', root, 'startup'), env);
  assert.equal(r.output, null);
  assert.equal(r.spawned, undefined);
  assert.ok(await exists(other));
  assert.equal((await readSession(other)).pid, null, 'a stale or earlier session of this process');
  assert.equal(await exists(sessionDir(root, 'new')), false);
});

// Slate session A, then an in-process /resume to a session without a folder (same process).
async function resumedAway() {
  const s = await activeSession('A');
  const r = await handle('SessionStart', start('B', s.root, 'resume'), s.env);
  assert.equal(r.output, null);
  assert.equal(await exists(sessionDir(s.root, 'B')), false);
  assert.equal((await readSession(s.dir)).pid, null, 'A released the pid');
  return s;
}

test('Important 1: resume to a non-slate session, then /clear: nothing moves', async () => {
  const { root, env, dir: a } = await resumedAway();
  const r = await handle('SessionStart', start('C', root, 'clear'), env);
  assert.equal(r.output, null);
  assert.ok(await exists(a));
  assert.equal(await exists(sessionDir(root, 'C')), false);
});

test('Important 1: resume to a non-slate session, then /branch: nothing is copied', async () => {
  const { root, env, dir: a } = await resumedAway();
  const r = await handle('SessionStart', start('C', root, 'fork'), env);
  assert.equal(r.output, null);
  assert.ok(await exists(a));
  assert.equal(await exists(sessionDir(root, 'C')), false);
});

test('Important 1: resuming A takes the pid back from every other folder; /clear then moves A only', async () => {
  const { root, env, dir: a } = await resumedAway();
  const { dir: other } = await initSession(root, 'X', PID); // e.g. an earlier /branch copy
  const r = await handle('SessionStart', start('A', root, 'resume'), env);
  assert.ok(ctx(r).startsWith('# slate memory'));
  assert.equal((await readSession(a)).pid, PID);
  assert.equal((await readSession(other)).pid, null);
  await handle('SessionStart', start('C', root, 'clear'), env);
  assert.equal(await exists(a), false);
  assert.equal((await readSession(sessionDir(root, 'C'))).from, 'A');
  assert.ok(await exists(other), 'the other folder stays');
});

test('Important 1: resuming A, then /branch copies A, not another folder', async () => {
  const { root, env, dir: a } = await resumedAway();
  const { dir: other } = await initSession(root, 'X', PID);
  await handle('SessionStart', start('A', root, 'resume'), env);
  await handle('SessionStart', start('C', root, 'fork'), env);
  assert.equal((await readSession(sessionDir(root, 'C'))).from, 'A');
  assert.ok(await exists(a));
  assert.equal((await readSession(other)).pid, null);
});

test('Important 1: a session start in another process never touches folders of other pids', async () => {
  const { root, env, dir: a } = await activeSession('A');
  const elsewhere = { ...env, CLAUDE_PID: '777' };
  for (const source of ['startup', 'resume']) await handle('SessionStart', start('B', root, source), elsewhere);
  assert.equal((await readSession(a)).pid, PID);
});

// A real detached curator (fake-claude `hang`) that has edited memory and is still running.
async function curatorMidEdit(id) {
  const s = await activeSession(id);
  s.env.FAKE_MODE = 'hang';
  s.env.FAKE_RECORD = path.join(s.root, 'record.jsonl');
  s.env.SLATE_WAIT_MS = '200';
  s.before = await readMemory(s.dir);
  await handle('UserPromptSubmit', prompt(id, s.root, 'use pnpm'), s.env);
  await handle('Stop', stop(id, s.root, 'ok, pnpm'), s.env);
  await until(async () => (await readMemory(s.dir))['instructions.md'].includes('fake item'));
  return s;
}

async function assertAborted(dir, before, record) {
  assert.deepEqual(await readMemory(dir), before, 'no unchecked edit');
  assert.deepEqual(await logTurns(dir), ['t1 aborted']);
  assert.match((await logLines(dir))[0], / t1 aborted: requeued$/);
  assert.equal(await exists(lockOf(dir)), false);
  assert.equal(await exists(path.join(dir, 'curated.json')), false, 'the aborted turn stays queued');
  const [{ pid }] = await fakeCalls(record);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

const lagNote = (dir, t) =>
  `slate: memory may not include turn ${t} yet — read ${path.join(dir, 'queue', `000${t}.md`)} before acting on recent instructions.`;

test('Important 2: /clear mid-curation aborts, moves, notes the missing turn and drains it in the new folder', async () => {
  const { root, env, dir: old, before } = await curatorMidEdit('old');
  env.FAKE_MODE = 'good'; // for the drain this SessionStart starts; the running curator hangs
  const t0 = Date.now();
  const r = await handle('SessionStart', start('new', root, 'clear'), env);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  const dir = sessionDir(root, 'new');
  assert.equal(await exists(old), false);
  assert.ok(ctx(r).startsWith(`# slate memory\n${lagNote(dir, 1)}\n`), ctx(r).slice(0, 400));
  assert.ok(!ctx(r).includes('fake item'), 'the block was built from the restored memory');
  assert.deepEqual(r.spawned, [CURATE, dir, '1', 'sonnet']);

  await waitLog(dir, 2);
  assert.deepEqual(await logTurns(dir), ['t1 aborted', 't1 ok']);
  assert.match((await logLines(dir))[0], / t1 aborted: requeued$/);
  const [hung, drained, ...rest] = await fakeCalls(env.FAKE_RECORD);
  assert.deepEqual(rest, []);
  assert.throws(() => process.kill(hung.pid, 0), { code: 'ESRCH' }, 'the aborted claude is gone');
  assert.ok(drained.prompt.includes(path.join(realpathSync(dir), 'instructions.md')), 'drained in the new folder');
  assert.notDeepEqual(await readMemory(dir), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'curated.json'), 'utf8')).turn, 1);

  // The next message's change line shows the drained turn's delta.
  const next = await handle('UserPromptSubmit', prompt('new', root, 'next'), env);
  assert.match(ctx(next), /\+I1 fake item/);
  assert.equal(await exists(old), false, 'nothing recreated the old folder');
});

test('Important 2: once curation has caught up, SessionStart adds no note and starts no drain', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('UserPromptSubmit', prompt(id, root, 'use pnpm'), env);
  await handle('Stop', stop(id, root, 'ok'), env);
  await waitLog(dir, 1);
  for (const source of ['resume', 'compact']) {
    const r = await handle('SessionStart', start(id, root, source), env);
    assert.ok(!ctx(r).includes('slate: memory'), source);
    assert.equal(r.spawned, undefined, source);
  }
});

test('Important 2: resume with a turn left uncurated drains it', async () => {
  const { root, env, dir, id } = await activeSession();
  await handle('UserPromptSubmit', prompt(id, root, 'use pnpm'), env);
  await appendAnswer(dir, 1, 'ok'); // a Stop whose curator never ran
  const r = await handle('SessionStart', start(id, root, 'resume'), env);
  assert.ok(ctx(r).includes(lagNote(dir, 1)));
  assert.deepEqual(r.spawned, [CURATE, dir, '1', 'sonnet']);
  await waitLog(dir, 1);
  assert.deepEqual(await logTurns(dir), ['t1 ok']);
});

test('M2: SessionStart while a curator still holds the lock says memory is still updating', async () => {
  const { root, env, dir, id } = await activeSession();
  env.SLATE_WAIT_MS = '200';
  await handle('UserPromptSubmit', prompt(id, root, 'use pnpm'), env);
  await appendAnswer(dir, 1, 'ok');
  const release = await acquire(dir);
  try {
    const r = await handle('SessionStart', start(id, root, 'compact'), env);
    const file = path.join(dir, 'queue', '0001.md');
    assert.ok(ctx(r).includes(`\nslate: memory still updating; it may not include turn 1 yet — read ${file} before acting on recent instructions.\n`), ctx(r).slice(0, 400));
    assert.equal(r.spawned, undefined, 'the lock holder rechecks after its release');
  } finally {
    await release();
  }
});

test('SessionStart fork with a curator mid-edit: aborts it; the parent is restored, the copy notes and drains the turn', async () => {
  const { root, env, dir: parent, before } = await curatorMidEdit('parent');
  env.FAKE_MODE = 'good';
  const r = await handle('SessionStart', start('child', root, 'fork'), env);
  const child = sessionDir(root, 'child');
  await assertAborted(parent, before, env.FAKE_RECORD);
  assert.equal((await readSession(child)).from, 'parent');
  assert.ok(ctx(r).startsWith(`# slate memory\n${lagNote(child, 1)}\n`), ctx(r).slice(0, 400));
  assert.deepEqual(r.spawned, [CURATE, child, '1', 'sonnet']);
  await waitLog(child, 2);
  assert.deepEqual(await logTurns(child), ['t1 aborted', 't1 ok']);
  assert.deepEqual(await readMemory(parent), before, 'the parent is untouched by the child drain');
});

test('SessionStart clear: a lock held by a process that is not a curator is never signalled', async () => {
  const { root, env, dir: old } = await activeSession('old');
  env.SLATE_WAIT_MS = '200';
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    await fs.writeFile(lockOf(old), `${holder.pid}\n`);
    const t0 = Date.now();
    const r = await handle('SessionStart', start('new', root, 'clear'), env);
    assert.ok(Date.now() - t0 >= 5000, 'waited for a release after deciding not to signal');
    process.kill(holder.pid, 0); // still alive
    assert.equal(holder.exitCode, null);
    assert.equal(await exists(old), false);
    assert.ok(ctx(r).startsWith('# slate memory'));
  } finally {
    holder.kill('SIGKILL');
  }
});

test('SLATE_WAIT_MS overrides the curator waits, clamped to 25,000', () => {
  assert.equal(curatorWaitMs({}, 20000), 20000);
  assert.equal(curatorWaitMs({ SLATE_WAIT_MS: '200' }, 20000), 200);
  assert.equal(curatorWaitMs({ SLATE_WAIT_MS: '0' }, 5000), 0);
  assert.equal(curatorWaitMs({ SLATE_WAIT_MS: '25000' }, 20000), 25000);
  assert.equal(curatorWaitMs({ SLATE_WAIT_MS: '99999' }, 20000), 25000);
  for (const bad of ['', '-1', '1.5', 'abc']) assert.equal(curatorWaitMs({ SLATE_WAIT_MS: bad }, 20000), 20000, bad);
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

test('hooks.json: five events, matcher, timeouts, quoted plugin-root commands', async () => {
  const cfg = JSON.parse(await fs.readFile(HOOKS_JSON, 'utf8'));
  assert.deepEqual(Object.keys(cfg), ['hooks']);
  const events = [...EVENTS, 'SubagentStop', 'PreToolUse'];
  assert.deepEqual(Object.keys(cfg.hooks).sort(), [...events].sort());
  const want = { SessionStart: 60, UserPromptSubmit: 30, Stop: 10, PreCompact: 90, SubagentStop: 10, PreToolUse: 10 };
  for (const event of events) {
    const groups = cfg.hooks[event];
    assert.equal(groups.length, 1, event);
    const [group] = groups;
    if (event === 'SessionStart') assert.equal(group.matcher, 'startup|resume|clear|compact|fork');
    else if (event === 'SubagentStop') assert.equal(group.matcher, 'slate:offload'); // matched on agent_type
    else if (event === 'PreToolUse') assert.equal(group.matcher, HANDBACK_TOOLS.join('|'));
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
