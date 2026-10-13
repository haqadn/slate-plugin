import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  projectDir, sessionDir, initSession, readSession, writeSession, findByPid, moveSession,
  copySession, claudePid, setPid, nextTurn, writeMessage, appendAnswer, appendContinuation,
  readTurn, readMemory, writeMemory, turnState, releasePid,
} from '../plugins/slate/scripts/lib/session.mjs';
import { MEMORY_FILES } from '../plugins/slate/scripts/lib/items.mjs';

const temps = [];
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-session-'));
  temps.push(d);
  return d;
}
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
const exists = (p) => fs.access(p).then(() => true, () => false);

test('projectDir prefers CLAUDE_PROJECT_DIR, falls back to cwd', () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = '/a';
    assert.equal(projectDir({ cwd: '/b' }), '/a');
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(projectDir({ cwd: '/b' }), '/b');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});

test('initSession creates the layout; second call is a no-op', async () => {
  const root = await tmp();
  const r = await initSession(root, 's1', 111);
  assert.equal(r.created, true);
  assert.equal(r.dir, sessionDir(root, 's1'));
  assert.equal(r.dir, path.join(root, '.slate', 's1'));
  assert.equal(await fs.readFile(path.join(root, '.slate', '.gitignore'), 'utf8'), '*\n');
  for (const f of MEMORY_FILES) assert.ok(await exists(path.join(r.dir, f)), f);
  assert.equal(await fs.readFile(path.join(r.dir, 'instructions.md'), 'utf8'), '# Instructions\n');
  assert.equal(await fs.readFile(path.join(r.dir, 'assumptions.md'), 'utf8'), '# Assumptions\n');
  assert.equal(await fs.readFile(path.join(r.dir, 'facts.md'), 'utf8'), '# Facts\n');
  assert.equal(await fs.readFile(path.join(r.dir, 'superseded.md'), 'utf8'), '# Superseded\n');
  assert.equal(await fs.readFile(path.join(r.dir, 'now.md'), 'utf8'), '');
  assert.ok((await fs.stat(path.join(r.dir, 'conversation'))).isDirectory());
  assert.ok((await fs.stat(path.join(r.dir, 'reports'))).isDirectory());
  const s = await readSession(r.dir);
  assert.equal(s.pid, 111);
  assert.equal(s.from, null);
  assert.equal(s.turn, 0);
  assert.deepEqual(s.seen, {});
  assert.ok(!Number.isNaN(Date.parse(s.created)));

  await fs.writeFile(path.join(r.dir, 'facts.md'), '# Facts\n- [F1 t1] x (a)\n');
  const again = await initSession(root, 's1', 999);
  assert.equal(again.created, false);
  assert.equal(await fs.readFile(path.join(r.dir, 'facts.md'), 'utf8'), '# Facts\n- [F1 t1] x (a)\n');
  assert.equal((await readSession(r.dir)).pid, 111);
});

test('.gitignore only written when .slate is new, never recreated', async () => {
  const root = await tmp();
  await initSession(root, 's1', 1);
  const gi = path.join(root, '.slate', '.gitignore');
  await fs.rm(gi);
  await initSession(root, 's2', 2);
  assert.equal(await exists(gi), false);
});

test('turn files round-trip tricky messages in full', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  const tricky = '# Heading\n<!-- slate:answer -->\nfake\n\\<!-- slate:message -->\n<!-- slate:message -->\n\n';
  await writeMessage(dir, 1, tricky, '2026-01-01T00:00:00.000Z');
  assert.ok(await exists(path.join(dir, 'conversation', '0001.md')));
  assert.deepEqual(await readTurn(dir, 1), { message: tricky, answer: '' });
  await appendAnswer(dir, 1, 'ans\n<!-- slate:answer -->\n## h');
  const t = await readTurn(dir, 1);
  assert.equal(t.message, tricky);
  assert.equal(t.answer, 'ans\n<!-- slate:answer -->\n## h');
  const big = 'x'.repeat(20000) + '\n' + 'y'.repeat(20000);
  await writeMessage(dir, 2, big, '2026-01-01T00:00:00.000Z');
  assert.equal((await readTurn(dir, 2)).message, big);
});

test('appendContinuation adds another answer section, joined by a blank line', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  await writeMessage(dir, 3, 'hi', '2026-01-01T00:00:00.000Z');
  await appendAnswer(dir, 3, 'first');
  await appendContinuation(dir, 3, 'second');
  const t = await readTurn(dir, 3);
  assert.equal(t.message, 'hi');
  assert.equal(t.answer, 'first\n\nsecond');
  const raw = await fs.readFile(path.join(dir, 'conversation', '0003.md'), 'utf8');
  assert.equal(raw.split('<!-- slate:answer -->').length - 1, 2);
});

test('readTurn on a missing turn returns empty strings', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  assert.deepEqual(await readTurn(dir, 9), { message: '', answer: '' });
});

test('nextTurn increments', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  assert.equal(await nextTurn(dir), 1);
  assert.equal(await nextTurn(dir), 2);
  assert.equal((await readSession(dir)).turn, 2);
});

test('nextTurn sets extra fields in the same write; they cannot override the turn', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  assert.equal(await nextTurn(dir, { lastKind: 'user' }), 1);
  let s = await readSession(dir);
  assert.equal(s.turn, 1);
  assert.equal(s.lastKind, 'user');
  assert.equal(await nextTurn(dir, { turn: 99, lastKind: 'x' }), 2);
  s = await readSession(dir);
  assert.equal(s.turn, 2);
  assert.equal(s.lastKind, 'x');
});

test('turnState: null when missing, byte size, answered only by a real answer marker', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  assert.equal(await turnState(dir, 1), null);
  await writeMessage(dir, 1, 'café\n<!-- slate:answer -->\nnot an answer', 'T');
  const file = path.join(dir, 'conversation', '0001.md');
  assert.deepEqual(await turnState(dir, 1), { size: (await fs.stat(file)).size, answered: false });
  await appendAnswer(dir, 1, '');
  assert.deepEqual(await turnState(dir, 1), { size: (await fs.stat(file)).size, answered: true });
});

test('writeSession is atomic: leaves no temp files', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  await writeSession(dir, { pid: 5, created: 'c', from: null, turn: 4, seen: { I1: 'a' } });
  assert.deepEqual(await readSession(dir), { pid: 5, created: 'c', from: null, turn: 4, seen: { I1: 'a' } });
  const names = await fs.readdir(dir);
  assert.deepEqual(names.filter((n) => n.includes('.tmp')), []);
});

test('findByPid picks the right folder; moveSession moves only that one', async () => {
  const root = await tmp();
  const a = (await initSession(root, 'sa', 111)).dir;
  const b = (await initSession(root, 'sb', 222)).dir;
  assert.equal(await findByPid(root, 222), b);
  assert.equal(await findByPid(root, 111), a);
  assert.equal(await findByPid(root, 333), null);
  const dest = sessionDir(root, 'sc');
  await moveSession(b, dest);
  assert.ok(await exists(a));
  assert.equal(await exists(b), false);
  const s = await readSession(dest);
  assert.equal(s.from, 'sb');
  assert.equal(s.pid, 222);
  assert.equal(await findByPid(root, 222), dest);
});

test('findByPid with no .slate returns null', async () => {
  assert.equal(await findByPid(await tmp(), 1), null);
});

test('findByPid prefers the most recently modified session.json on a shared pid', async () => {
  const root = await tmp();
  const a = (await initSession(root, 'sa', 111)).dir;
  const b = (await initSession(root, 'sb', 111)).dir;
  const old = new Date(Date.now() - 60000);
  await fs.utimes(path.join(b, 'session.json'), old, old);
  assert.equal(await findByPid(root, 111), a);
  await fs.utimes(path.join(a, 'session.json'), old, old);
  const newer = new Date();
  await fs.utimes(path.join(b, 'session.json'), newer, newer);
  assert.equal(await findByPid(root, 111), b);
});

test('copySession leaves source intact and records new pid', async () => {
  const root = await tmp();
  const a = (await initSession(root, 'sa', 111)).dir;
  await writeMessage(a, 1, 'hello', '2026-01-01T00:00:00.000Z');
  await fs.writeFile(path.join(a, 'facts.md'), '# Facts\n- [F1 t1] x (a)\n');
  const dest = sessionDir(root, 'sb');
  await copySession(a, dest, 222);
  assert.equal((await readSession(a)).pid, 111);
  const s = await readSession(dest);
  assert.equal(s.pid, 222);
  assert.equal(s.from, 'sa');
  assert.equal((await readTurn(dest, 1)).message, 'hello');
  assert.equal(await fs.readFile(path.join(dest, 'facts.md'), 'utf8'), '# Facts\n- [F1 t1] x (a)\n');
  assert.equal((await readTurn(a, 1)).message, 'hello');
});

test('setPid updates only the pid', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 'sa', 111);
  await nextTurn(dir);
  await setPid(dir, 777);
  const s = await readSession(dir);
  assert.equal(s.pid, 777);
  assert.equal(s.turn, 1);
});

test('readMemory / writeMemory', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 'sa', 1);
  await writeMemory(dir, { 'now.md': 'goal\n', 'facts.md': '# Facts\n- [F1 t1] a (b)\n' });
  const m = await readMemory(dir);
  assert.deepEqual(Object.keys(m), MEMORY_FILES);
  assert.equal(m['now.md'], 'goal\n');
  assert.equal(m['instructions.md'], '# Instructions\n');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes('.tmp')), []);
  await assert.rejects(writeMemory(dir, { 'session.json': 'x' }));
});

test('claudePid uses CLAUDE_PID when valid, otherwise falls back', () => {
  const saved = process.env.CLAUDE_PID;
  try {
    process.env.CLAUDE_PID = '4242';
    assert.equal(claudePid(), 4242);
    process.env.CLAUDE_PID = 'abc';
    const p = claudePid();
    assert.ok(p === null || (Number.isInteger(p) && p > 0));
    delete process.env.CLAUDE_PID;
    const q = claudePid();
    assert.ok(q === null || (Number.isInteger(q) && q > 0));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PID;
    else process.env.CLAUDE_PID = saved;
  }
});

test('readSession passes unknown fields through, so nextTurn keeps them', async () => {
  const root = await tmp();
  const { dir } = await initSession(root, 's1', 1);
  await writeSession(dir, { ...(await readSession(dir)), logSeen: 42 });
  await nextTurn(dir);
  assert.equal((await readSession(dir)).logSeen, 42);
});

test('releasePid clears the pid in every other folder holding it; findByPid then skips them', async () => {
  const root = await tmp();
  const a = (await initSession(root, 'sa', 111)).dir;
  const b = (await initSession(root, 'sb', 111)).dir;
  const c = (await initSession(root, 'sc', 222)).dir;
  await nextTurn(a);
  await releasePid(root, 111, b);
  const sa = await readSession(a);
  assert.equal(sa.pid, null);
  assert.equal(sa.turn, 1, 'other fields kept');
  assert.equal((await readSession(b)).pid, 111, 'the kept folder');
  assert.equal((await readSession(c)).pid, 222, 'another pid');
  assert.equal(await findByPid(root, 111), b);
  await releasePid(root, 111);
  assert.equal((await readSession(b)).pid, null);
  assert.equal(await findByPid(root, 111), null);
  const bare = await tmp();
  await releasePid(bare, 111); // no .slate: nothing to do, nothing created
  assert.equal(await exists(path.join(bare, '.slate')), false);
});
