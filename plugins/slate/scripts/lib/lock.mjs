import fs from 'node:fs/promises';
import path from 'node:path';

const STALE_UNPARSED_MS = 5000;

function lockPath(dir) {
  return path.join(dir, 'curator.lock');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 'free' | 'held'. A dead-pid lock counts as free. An unreadable pid (the holder is
// mid-write) counts as held until the file is a few seconds old.
async function state(file) {
  let text, st;
  try {
    text = await fs.readFile(file, 'utf8');
    st = await fs.stat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return 'free';
    throw e;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) return alive(pid) ? 'held' : 'free';
  return Date.now() - st.mtimeMs > STALE_UNPARSED_MS ? 'free' : 'held';
}

export async function acquire(dir) {
  const file = lockPath(dir);
  const mine = `${process.pid}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.writeFile(file, mine, { flag: 'wx' });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          if ((await fs.readFile(file, 'utf8')) === mine) await fs.unlink(file);
        } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if ((await state(file)) === 'held') return null;
    try {
      await fs.unlink(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return null;
}

// The pid written in the lock file, or null when there is no lock or no readable pid.
export async function lockHolder(dir) {
  try {
    const pid = Number.parseInt((await fs.readFile(lockPath(dir), 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function waitFree(dir, ms) {
  const file = lockPath(dir);
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await state(file)) === 'free') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}
