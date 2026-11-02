import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { handle } from '../plugins/slate/scripts/hook.mjs';
import { run } from '../plugins/slate/scripts/slate.mjs';
import { readSession, readTurn, readMemory, appendAnswer } from '../plugins/slate/scripts/lib/session.mjs';
import { findSession, sweepSessions } from '../plugins/slate/scripts/lib/slate.mjs';
import { initSession } from './helpers.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'plugins/slate/scripts/codex-slate.mjs');
const HOOK = path.join(ROOT, 'plugins/slate/scripts/codex-hook.mjs');
const CURATE = path.join(ROOT, 'plugins/slate/scripts/curate.mjs');
const FAKE = path.join(ROOT, 'test/fixtures/fake-claude.mjs');
const temps = [];
after(async () => {
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-codex-test-'));
  temps.push(root);
  const env = {
    ...process.env, SLATE_HOME: path.join(root, 'home'), SLATE_RUNTIME: 'codex',
    SLATE_CODEX_BIN: FAKE, SLATE_CODEX_MODEL: 'test-model', CODEX_THREAD_ID: 'codex-thread',
    CLAUDE_PID: String(process.pid), SLATE_CLAUDE_BIN: '/no-claude-allowed',
    FAKE_MODE: 'good', FAKE_RECORD: path.join(root, 'calls.jsonl'),
  };
  delete env.SLATE_CURATOR;
  return { root, env };
}

const cli = (s, args, extra = {}) => exec(process.execPath, [CLI, ...args], { cwd: s.root, env: { ...s.env, ...extra } });
const context = (r) => r.output?.hookSpecificOutput?.additionalContext;
const calls = async (s) => (await fs.readFile(s.env.FAKE_RECORD, 'utf8')).trim().split('\n').map(JSON.parse);

async function hook(s, event, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, event], { cwd: s.root, env: s.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => code ? reject(new Error(stderr)) : resolve(stdout ? JSON.parse(stdout) : null));
    child.stdin.end(JSON.stringify({ session_id: s.env.CODEX_THREAD_ID, ...input }));
  });
}

async function waitCurated(dir) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const log = await fs.readFile(path.join(dir, 'curator.log'), 'utf8').catch(() => '');
    const locked = await fs.access(path.join(dir, 'curator.lock')).then(() => true, () => false);
    if (log.includes(' t1 ok:') && !locked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('curator did not finish');
}

test('Codex link, prompt, Stop and resume use Codex without a Claude installation', async () => {
  const s = await setup();
  const sid = s.env.CODEX_THREAD_ID;
  assert.match((await cli(s, ['link', 'work'])).stdout, /^confirm-create work\n/);
  const linked = (await cli(s, ['link', 'work', '--create'])).stdout;
  assert.match(linked, /^linked\n# slate memory/);
  assert.doesNotMatch(linked, /slate:offload|Bash there is denied|AskUserQuestion/);
  const dir = await findSession(s.env.SLATE_HOME, sid);
  assert.equal((await readSession(dir)).runtime, 'codex');
  assert.equal((await readSession(dir)).pid, null);
  const result = await hook(s, 'UserPromptSubmit', { prompt: 'Use pnpm.', turn_id: 'turn-1' });
  assert.match(result.hookSpecificOutput.additionalContext, /delegate heavy work/);
  await hook(s, 'Stop', { last_assistant_message: 'Using pnpm.', turn_id: 'turn-1' });
  await waitCurated(dir);
  assert.deepEqual(await readTurn(dir, 1), { message: 'Use pnpm.', answer: 'Using pnpm.' });
  const [call] = await calls(s);
  assert.equal(call.args[0], 'exec');
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'test-model');
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  for (const flag of ['--ephemeral', '--ignore-user-config', 'features.hooks=false', 'approval_policy="never"']) {
    assert.ok(call.args.includes(flag), flag);
  }
  assert.equal(call.env.CODEX_THREAD_ID, undefined);
  assert.equal(call.env.CLAUDE_PID, undefined);
  assert.equal(call.env.SLATE_CURATOR, '1');
  assert.ok(call.schema.properties.ops.items.anyOf);
  assert.ok(call.schema.properties.ops.items.anyOf.every((op) => op.properties.op.type === 'string'));
  await assert.rejects(fs.access(call.args[call.args.indexOf('--output-schema') + 1]), { code: 'ENOENT' });
  for (const source of ['resume', 'compact']) {
    const reloaded = await hook(s, 'SessionStart', { source });
    assert.match(reloaded.hookSpecificOutput.additionalContext, /fake item 1/);
    assert.doesNotMatch(reloaded.hookSpecificOutput.additionalContext, /slate:offload/);
  }
});

test('Codex never infers a thread link from a shared process or missing thread ID', async () => {
  const s = await setup();
  const { dir } = await initSession(s.env.SLATE_HOME, 'claude-thread', process.pid);
  const before = await readSession(dir);
  for (const source of ['startup', 'resume', 'clear', 'fork']) {
    assert.equal((await handle('SessionStart', { session_id: 'new-thread', source }, s.env)).output, null);
    assert.equal(await findSession(s.env.SLATE_HOME, 'new-thread'), null);
    assert.deepEqual(await readSession(dir), before);
  }
  await assert.rejects(cli(s, ['link', 'work', '--create'], { CODEX_THREAD_ID: '' }), /CODEX_THREAD_ID is missing/);
  assert.match((await cli(s, ['link', '../escape', '--create'])).stdout, /^error /);
});

test('active Codex threads prevent deletion and cleanup until they end or switch slates', async () => {
  const s = await setup();
  await cli(s, ['link', 'work', '--create']);
  const sid = s.env.CODEX_THREAD_ID;
  const dir = await findSession(s.env.SLATE_HOME, sid);
  const sessionFile = path.join(dir, 'session.json');
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(sessionFile, old, old);
  assert.deepEqual(await sweepSessions(s.env.SLATE_HOME), []);
  assert.match((await run(['done', 'other', 'work', '--yes'], s.env)).out, /^refused work live codex-th/);
  await hook(s, 'SessionEnd', { reason: 'other' });
  assert.equal((await readSession(dir)).active, false);
  await hook(s, 'SessionStart', { source: 'resume' });
  assert.equal((await readSession(dir)).active, true);
  await cli(s, ['link', 'next', '--create']);
  assert.match((await run(['done', 'other', 'work', '--yes'], s.env)).out, /^deleted work/);
  await hook(s, 'SessionEnd', {});
  assert.match((await run(['done', 'other', 'next', '--yes'], s.env)).out, /^deleted next/);
});

test('Codex subagent returns are capped and indexed without touching the root turn', async () => {
  const s = await setup();
  await cli(s, ['link', 'work', '--create']);
  const dir = await findSession(s.env.SLATE_HOME, s.env.CODEX_THREAD_ID);
  const input = { agent_id: 'worker-1', agent_type: 'default', agent_transcript_path: '/tmp/worker.jsonl' };
  const blocked = await hook(s, 'SubagentStop', { ...input, last_assistant_message: 'x'.repeat(801) });
  assert.equal(blocked.decision, 'block');
  assert.equal(await hook(s, 'SubagentStop', { ...input, stop_hook_active: true, last_assistant_message: 'Done. Report: reports/check.md' }), null);
  const index = await fs.readFile(path.join(s.env.SLATE_HOME, 'work', 'offloads.md'), 'utf8');
  assert.match(index, /worker-1/);
  assert.match(index, /\/tmp\/worker.jsonl/);
  await hook(s, 'UserPromptSubmit', { agent_id: 'worker-1', prompt: 'Do delegated work.' });
  assert.equal((await readSession(dir)).turn, 0);
});

test('Codex curator retries rejected changes and preserves memory on invalid output or process failure', async () => {
  for (const mode of ['invalid-then-good', 'garbage', 'fail']) {
    const s = await setup();
    await cli(s, ['link', 'work', '--create']);
    const dir = await findSession(s.env.SLATE_HOME, s.env.CODEX_THREAD_ID);
    await hook(s, 'UserPromptSubmit', { prompt: 'Use pnpm.' });
    const before = await readMemory(dir);
    await appendAnswer(dir, 1, 'Using pnpm.');
    const promise = exec(process.execPath, [CURATE, dir, '1'], { env: { ...s.env, FAKE_MODE: mode } });
    if (mode === 'invalid-then-good') {
      await promise;
      assert.equal((await calls(s)).length, 2);
      assert.match((await readMemory(dir))['instructions.md'], /fake item 1/);
    } else {
      await assert.rejects(promise);
      assert.deepEqual(await readMemory(dir), before);
    }
  }
});
