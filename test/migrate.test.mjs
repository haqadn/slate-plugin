import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findSession } from '../plugins/slate/scripts/lib/slate.mjs';
import { memoryBlock } from '../plugins/slate/scripts/lib/inject.mjs';

const TOOL = path.resolve('tools/migrate-session.mjs');
const ID = '82b3114c-5e73-4142-ae8c-b8564fbac2d9';
const temps = [];
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});

const FILES = {
  'instructions.md': '# Instructions\n- [I1 t0] Keep replies short.\n- [I2 t3] Use tabs.\n',
  'assumptions.md': '# Assumptions\n- [A1 t2] The API is stable.\n',
  'facts.md': '# Facts\n- [F12 t3] The sky is blue (source: test).\n',
  'superseded.md': '# Superseded\n- [I3 t1 retired t5] Old rule (reason: replaced)\n',
  'offloads.md': '# Offloads\n\n## t4 2026-10-01T10:00:00Z agent1\nreturn text\n\n## t6 2026-10-02T10:00:00Z agent2\nmore\n',
  'now.md': 'Goal: test\n',
  'session.json': JSON.stringify({ pid: 1, created: '2026-10-01T00:00:00Z', turn: 6, seen: { F12: 3 } }) + '\n',
  'curated.json': '{"turn":5,"size":10}\n',
  'curator.log': '2026-10-01 ok\n',
  'reports/r1.md': 'report one\n',
  'queue/0006.md': 'queued\n',
  'handbacks/a1.md': 'marker\n',
  'conversation/0001.md': 'skip me\n',
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-migrate-'));
  temps.push(root);
  const old = path.join(root, 'old', ID);
  for (const [f, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(old, f)), { recursive: true });
    await fs.writeFile(path.join(old, f), text);
  }
  return { root, old, home: path.join(root, 'home') };
}

const run = (home, ...args) =>
  spawnSync(process.execPath, [TOOL, ...args], { env: { ...process.env, SLATE_HOME: home }, encoding: 'utf8' });

async function snapshot(dir) {
  const out = {};
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) {
      const p = path.join(e.parentPath, e.name);
      out[path.relative(dir, p)] = await fs.readFile(p, 'utf8');
    }
  }
  return out;
}

test('migrates files byte-identically and leaves the source alone', async () => {
  const { old, home } = await fixture();
  const before = await snapshot(old);
  const r = run(home, old, 'jetpack-seo');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await snapshot(old), before, 'source unchanged');
  const slate = path.join(home, 'jetpack-seo');
  const session = path.join(slate, '.sessions', ID);
  for (const f of ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md', 'offloads.md', 'reports/r1.md']) {
    assert.equal(await fs.readFile(path.join(slate, f), 'utf8'), FILES[f], f);
  }
  for (const f of ['now.md', 'session.json', 'curated.json', 'curator.log', 'queue/0006.md', 'handbacks/a1.md']) {
    assert.equal(await fs.readFile(path.join(session, f), 'utf8'), FILES[f], f);
  }
  assert.equal(await fs.stat(path.join(session, 'conversation')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(session, 'curator.lock')).catch(() => null), null);
  assert.match(r.stdout, /instructions\.md\s+2\s+2/, 'item counts per file, source and target');
  assert.equal(await findSession(home, ID), session);
  const block = await memoryBlock(session);
  assert.match(block, /Keep replies short/);
  assert.match(block, /The sky is blue/);
});

test('refuses when the slate exists', async () => {
  const { old, home } = await fixture();
  assert.equal(run(home, old, 'jetpack-seo').status, 0);
  const r = run(home, old, 'jetpack-seo');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists/);
});

test('refuses when a live curator holds the lock, and creates nothing', async () => {
  const { old, home } = await fixture();
  await fs.writeFile(path.join(old, 'curator.lock'), `${process.pid} x\n`);
  const r = run(home, old, 'jetpack-seo');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /curator/);
  assert.equal(await fs.stat(path.join(home, 'jetpack-seo')).catch(() => null), null);
});

test('a dead curator lock is ignored and not copied', async () => {
  const { old, home } = await fixture();
  await fs.writeFile(path.join(old, 'curator.lock'), '999999999 x\n');
  const r = run(home, old, 'jetpack-seo');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await fs.stat(path.join(home, 'jetpack-seo', '.sessions', ID, 'curator.lock')).catch(() => null), null);
});

test('rejects a bad name', async () => {
  const { old, home } = await fixture();
  const r = run(home, old, 'Jetpack SEO');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /a-z0-9/);
});
