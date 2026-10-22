import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquire, waitFree, lockHolder } from '../plugins/slate/scripts/lib/lock.mjs';

const temps = [];
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-lock-'));
  temps.push(d);
  return d;
}
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
const lockFile = (d) => path.join(d, 'curator.lock');

test('acquire, second acquire is null, release frees it', async () => {
  const dir = await tmp();
  const release = await acquire(dir);
  assert.equal(typeof release, 'function');
  assert.equal((await fs.readFile(lockFile(dir), 'utf8')).trim(), String(process.pid));
  assert.equal(await acquire(dir), null);
  await release();
  const again = await acquire(dir);
  assert.equal(typeof again, 'function');
  await again();
  await release(); // double release is harmless
});

test('a lock held by a dead pid is taken over', async () => {
  const dir = await tmp();
  await fs.writeFile(lockFile(dir), '999999\n');
  const release = await acquire(dir);
  assert.equal(typeof release, 'function');
  assert.equal((await fs.readFile(lockFile(dir), 'utf8')).trim(), String(process.pid));
  await release();
});

test('waitFree: false on timeout while held, true once released, true when dead', async () => {
  const dir = await tmp();
  assert.equal(await waitFree(dir, 100), true);
  const release = await acquire(dir);
  const t0 = Date.now();
  assert.equal(await waitFree(dir, 200), false);
  assert.ok(Date.now() - t0 >= 150);
  setTimeout(() => release(), 100);
  assert.equal(await waitFree(dir, 2000), true);
  await fs.writeFile(lockFile(dir), '999999\n');
  assert.equal(await waitFree(dir, 100), true);
});

test('a named lock is a separate file; waitFree and lockHolder take the same name', async () => {
  const dir = await tmp();
  const memory = await acquire(dir, 'memory.lock');
  assert.equal(typeof memory, 'function');
  assert.equal((await fs.readFile(path.join(dir, 'memory.lock'), 'utf8')).trim(), String(process.pid));
  assert.equal(await lockHolder(dir, 'memory.lock'), process.pid);
  assert.equal(await lockHolder(dir), null, 'curator.lock is untouched');
  assert.equal(await waitFree(dir, 0), true);
  assert.equal(await waitFree(dir, 0, 'memory.lock'), false);
  assert.equal(await acquire(dir, 'memory.lock'), null);
  const curator = await acquire(dir);
  assert.equal(typeof curator, 'function', 'the default curator.lock is still free');
  await memory();
  assert.equal(await waitFree(dir, 0, 'memory.lock'), true);
  await curator();
});
