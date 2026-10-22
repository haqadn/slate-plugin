import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const STALE_UNPARSED_MS = 5000;
// A session's curator.lock serialises its curators; a slate's memory.lock, its memory writes.
const CURATOR_LOCK = 'curator.lock';
const ATTEMPTS = 3;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A lock file's state, and its text when there is one: 'gone', 'held' (a live pid, or no
// readable pid on a file a few seconds old at most) or 'dead'. Read through one handle, so the
// text and the age are the same file's.
async function inspect(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'gone' };
    throw e;
  }
  try {
    const text = await fh.readFile('utf8');
    const pid = Number.parseInt(text, 10);
    if (Number.isInteger(pid) && pid > 0) return { state: alive(pid) ? 'held' : 'dead', text };
    const { mtimeMs } = await fh.stat();
    return { state: Date.now() - mtimeMs > STALE_UNPARSED_MS ? 'dead' : 'held', text };
  } finally {
    await fh.close();
  }
}

// Creates `file` holding `<pid> <nonce>`, so its text names this one acquisition, or returns null
// when it exists. Linked into place fully written: a lock is never seen empty.
let seq = 0;
async function create(file) {
  const mine = `${process.pid} ${randomUUID()}\n`;
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  try {
    await fs.writeFile(tmp, mine);
    await fs.link(tmp, file);
    return mine;
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// Unlinks `file` if it still holds `text`. Only safe where nothing else can replace that text in
// between: the caller's own lock, or a dead lock while the caller holds its claim.
async function removeIf(file, text) {
  try {
    if ((await fs.readFile(file, 'utf8')) === text) await fs.unlink(file);
  } catch {}
}

// Removes a dead holder's lock that held `text`. Claimants take turns through `<lock>.claim`.
// While that text is in place nothing else can remove or replace it (its holder is dead, and a
// create fails while the file exists), so the claim holder can check the text and unlink.
async function removeDead(file, text) {
  const claim = `${file}.claim`;
  const mine = await create(claim);
  if (!mine) {
    // A claimant that died mid-claim leaves its claim behind.
    const c = await inspect(claim);
    if (c.state === 'dead') await removeIf(claim, c.text);
    return;
  }
  try {
    await removeIf(file, text);
  } finally {
    await removeIf(claim, mine);
  }
}

export async function acquire(dir, name = CURATOR_LOCK) {
  const file = path.join(dir, name);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const mine = await create(file);
    if (mine) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await removeIf(file, mine);
      };
    }
    const lock = await inspect(file);
    if (lock.state === 'held') return null;
    if (lock.state === 'dead') await removeDead(file, lock.text);
    // 'gone': released since the create failed. Never unlink on that basis; try the create again.
  }
  return null;
}

// The pid written in the lock file, or null when there is no lock or no readable pid.
export async function lockHolder(dir, name = CURATOR_LOCK) {
  try {
    const pid = Number.parseInt(await fs.readFile(path.join(dir, name), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// True once the lock is free: gone, or its holder dead.
export async function waitFree(dir, ms, name = CURATOR_LOCK) {
  const file = path.join(dir, name);
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await inspect(file)).state !== 'held') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}
