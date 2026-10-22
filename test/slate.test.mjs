import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  slateHome, validName, slateDir, slateOf, memoryPath, createSlate, createSession, listSlates, sessionDirs,
  findSession,
} from '../plugins/slate/scripts/lib/slate.mjs';

const temps = [];
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-layout-'));
  temps.push(d);
  return d;
}
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
const exists = (p) => fs.access(p).then(() => true, () => false);

test('slateHome honors SLATE_HOME, else ~/slate', () => {
  assert.equal(slateHome({ SLATE_HOME: '/x/y' }), '/x/y');
  assert.equal(slateHome({}), path.join(os.homedir(), 'slate'));
  assert.equal(slateHome({ SLATE_HOME: '' }), path.join(os.homedir(), 'slate'));
});

test('validName', () => {
  for (const ok of ['jetpack-seo', 'a1', 'a', 'a'.repeat(64)]) assert.equal(validName(ok), true, ok);
  for (const bad of ['Jetpack', 'jetpack seo', '-x', 'x-', 'a--b', '../x', '', 'a'.repeat(65), 'a/b', 'a_b', null, 5]) {
    assert.equal(validName(bad), false, String(bad));
  }
});

test('slateDir and slateOf', () => {
  assert.equal(slateDir('/h', 'x'), '/h/x');
  assert.equal(slateOf('/h/x/.sessions/abc'), '/h/x');
});

test('memoryPath: now.md in the session, the other four in the slate, anything else throws', () => {
  const dir = '/h/x/.sessions/abc';
  assert.equal(memoryPath(dir, 'now.md'), '/h/x/.sessions/abc/now.md');
  for (const f of ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md']) {
    assert.equal(memoryPath(dir, f), `/h/x/${f}`);
  }
  assert.throws(() => memoryPath(dir, 'session.json'));
  assert.throws(() => memoryPath(dir, '../x.md'));
});

test('createSlate then createSession build the layout; a second call is a no-op', async () => {
  const home = await tmp();
  const s = await createSlate(home, 'jetpack-seo');
  assert.deepEqual(s, { created: true, dir: path.join(home, 'jetpack-seo') });
  const titles = {
    'instructions.md': '# Instructions\n', 'assumptions.md': '# Assumptions\n',
    'facts.md': '# Facts\n', 'superseded.md': '# Superseded\n',
  };
  for (const [f, t] of Object.entries(titles)) assert.equal(await fs.readFile(path.join(s.dir, f), 'utf8'), t);
  assert.ok((await fs.stat(path.join(s.dir, 'reports'))).isDirectory());
  assert.ok((await fs.stat(path.join(s.dir, '.sessions'))).isDirectory());
  assert.equal(await exists(path.join(s.dir, 'now.md')), false);

  const r = await createSession(s.dir, 'sid-1', 111);
  assert.deepEqual(r, { created: true, dir: path.join(s.dir, '.sessions', 'sid-1') });
  assert.equal(await fs.readFile(path.join(r.dir, 'now.md'), 'utf8'), '');
  assert.ok((await fs.stat(path.join(r.dir, 'queue'))).isDirectory());
  const j = JSON.parse(await fs.readFile(path.join(r.dir, 'session.json'), 'utf8'));
  assert.deepEqual({ ...j, created: typeof j.created }, { pid: 111, created: 'string', from: null, turn: 0, seen: {} });
  assert.ok(!Number.isNaN(Date.parse(j.created)));

  await fs.writeFile(path.join(s.dir, 'facts.md'), '# Facts\n- [F1 t1] x\n');
  assert.deepEqual(await createSlate(home, 'jetpack-seo'), { created: false, dir: s.dir });
  assert.equal(await fs.readFile(path.join(s.dir, 'facts.md'), 'utf8'), '# Facts\n- [F1 t1] x\n');
  assert.deepEqual(await createSession(s.dir, 'sid-1', 999), { created: false, dir: r.dir });
  assert.equal(JSON.parse(await fs.readFile(path.join(r.dir, 'session.json'), 'utf8')).pid, 111);
});

test('createSlate throws on an invalid name and creates nothing', async () => {
  const home = await tmp();
  for (const bad of ['Jetpack', '../x', '', 'a'.repeat(65)]) await assert.rejects(createSlate(home, bad), bad);
  assert.deepEqual(await fs.readdir(home), []);
});

test('findSession finds a session in either slate, null for unknown, ignores detached folders', async () => {
  const home = await tmp();
  const a = await createSlate(home, 'one');
  const b = await createSlate(home, 'two');
  const sa = await createSession(a.dir, 'sid-a', 1);
  const sb = await createSession(b.dir, 'sid-b', 2);
  await createSession(b.dir, 'sid-c.detached-123', 3);
  assert.equal(await findSession(home, 'sid-a'), sa.dir);
  assert.equal(await findSession(home, 'sid-b'), sb.dir);
  assert.equal(await findSession(home, 'nope'), null);
  assert.equal(await findSession(home, 'sid-c'), null);
  assert.equal(await findSession(home, 'sid-c.detached-123'), null);
  assert.equal(await findSession(path.join(home, 'missing'), 'sid-a'), null);
  assert.deepEqual((await sessionDirs(home)).sort(), [sa.dir, sb.dir].sort());
});

test('findSession ignores a folder without session.json', async () => {
  const home = await tmp();
  const a = await createSlate(home, 'one');
  await fs.mkdir(path.join(a.dir, '.sessions', 'half'), { recursive: true });
  assert.equal(await findSession(home, 'half'), null);
});

test('listSlates: newest session activity first; folder mtime when there are no sessions; skips bad names', async () => {
  const home = await tmp();
  const a = await createSlate(home, 'old');
  const b = await createSlate(home, 'new');
  const c = await createSlate(home, 'empty');
  const sa = await createSession(a.dir, 's1', 1);
  const sb = await createSession(b.dir, 's2', 1);
  await fs.mkdir(path.join(home, 'Not A Slate'));
  await fs.writeFile(path.join(home, 'file.txt'), '');
  const t = (ms) => new Date(Date.now() - ms);
  await fs.utimes(path.join(sa.dir, 'session.json'), t(50000), t(50000));
  await fs.utimes(path.join(sb.dir, 'session.json'), t(10000), t(10000));
  await fs.utimes(c.dir, t(30000), t(30000));
  const list = await listSlates(home);
  assert.deepEqual(list.map((s) => s.name), ['new', 'empty', 'old']);
  assert.equal(list[0].dir, b.dir);
  assert.ok(Math.abs(list[1].lastUsed - t(30000).getTime()) < 2000);
  assert.deepEqual(await listSlates(path.join(home, 'missing')), []);
});
