import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquire, waitFree, lockHolder } from '../plugins/slate/scripts/lib/lock.mjs';

const LOCK = new URL('../plugins/slate/scripts/lib/lock.mjs', import.meta.url).href;

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
const pidIn = async (file) => Number.parseInt(await fs.readFile(file, 'utf8'), 10);

// The pid of a process that has exited.
async function deadPid() {
  const p = spawn(process.execPath, ['-e', '']);
  await once(p, 'exit');
  return p.pid;
}

test('acquire, second acquire is null, release frees it', async () => {
  const dir = await tmp();
  const release = await acquire(dir);
  assert.equal(typeof release, 'function');
  assert.equal(await pidIn(lockFile(dir)), process.pid);
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
  assert.equal(await pidIn(lockFile(dir)), process.pid);
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
  assert.equal(await pidIn(path.join(dir, 'memory.lock')), process.pid);
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

// Each claimant takes the lock `rounds` times, logging +pid on entry and -pid on exit.
const CLAIM = `
const [mod, dir, log, start, rounds] = process.argv.slice(1);
const fs = await import('node:fs/promises');
const { acquire } = await import(mod);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(Math.max(0, Number(start) - Date.now()));
for (let i = 0; i < Number(rounds); i++) {
  let release;
  while (!(release = await acquire(dir, 'memory.lock'))) await sleep(1);
  await fs.appendFile(log, '+' + process.pid + '\\n');
  await sleep(2);
  await fs.appendFile(log, '-' + process.pid + '\\n');
  await release();
}
`;

test("Review Focus 2: six claimants racing for a dead holder's lock, then for each other's, hold it one at a time", async () => {
  const CLAIMANTS = 6;
  const ROUNDS = 10;
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'memory.lock'), `${await deadPid()}\n`);
  const log = path.join(dir, 'holds.log');
  const start = String(Date.now() + 300);
  const kids = Array.from({ length: CLAIMANTS }, () => spawn(process.execPath,
    ['--input-type=module', '-e', CLAIM, LOCK, dir, log, start, String(ROUNDS)], { stdio: ['ignore', 'ignore', 'inherit'] }));
  const codes = await Promise.all(kids.map(async (k) => (await once(k, 'exit'))[0]));
  assert.deepEqual(codes, Array(CLAIMANTS).fill(0));
  const events = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
  assert.equal(events.length, CLAIMANTS * ROUNDS * 2);
  for (let i = 0; i < events.length; i += 2) {
    assert.match(events[i], /^\+\d+$/, `event ${i}`);
    assert.equal(events[i + 1], `-${events[i].slice(1)}`, `two holders at once at event ${i}`);
  }
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n !== 'holds.log'), [], 'no lock or claim left');
});

test('a claim left by a claimant that died mid-takeover does not block the next takeover', async () => {
  const dir = await tmp();
  const dead = await deadPid();
  await fs.writeFile(path.join(dir, 'memory.lock'), `${dead}\n`);
  await fs.writeFile(path.join(dir, 'memory.lock.claim'), `${dead}\n`);
  const release = await acquire(dir, 'memory.lock');
  assert.equal(typeof release, 'function');
  assert.equal(await pidIn(path.join(dir, 'memory.lock')), process.pid);
  await release();
  assert.deepEqual(await fs.readdir(dir), []);
});

test('release removes only its own lock, even when the same process locked again since', async () => {
  const dir = await tmp();
  const first = await acquire(dir);
  await fs.rm(lockFile(dir)); // e.g. taken over as dead (a pid in another namespace)
  const second = await acquire(dir);
  await first(); // a stale release must not remove the second lock
  assert.equal(await pidIn(lockFile(dir)), process.pid);
  assert.equal(await acquire(dir), null, 'still held');
  await second();
  assert.equal(await waitFree(dir, 0), true);
});
