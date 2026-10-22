// Shared slate layout: <home>/<name>/ holds the shared files; .sessions/<id>/ holds one session's.
import fs from 'node:fs/promises';
import { realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const SHARED = ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md'];
const TITLES = {
  'instructions.md': '# Instructions\n',
  'assumptions.md': '# Assumptions\n',
  'facts.md': '# Facts\n',
  'superseded.md': '# Superseded\n',
};
const DETACHED = '.detached-';

export function slateHome(env = process.env) {
  return env.SLATE_HOME || path.join(os.homedir(), 'slate');
}

export function validName(name) {
  return typeof name === 'string' && name.length <= NAME_MAX && NAME.test(name);
}

export function slateDir(home, name) {
  return path.join(home, name);
}

export function slateOf(sessionDir) {
  return path.dirname(path.dirname(sessionDir));
}

// now.md is the session's; the other four memory files are the slate's.
export function memoryPath(sessionDir, file) {
  if (file === 'now.md') return path.join(sessionDir, file);
  if (SHARED.includes(file)) return path.join(slateOf(sessionDir), file);
  throw new Error(`not a memory file: ${file}`);
}

async function mkdirNew(dir) {
  try {
    await fs.mkdir(dir);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

export async function createSlate(home, name) {
  if (!validName(name)) throw new Error(`invalid slate name: ${JSON.stringify(name)}`);
  const dir = slateDir(home, name);
  await fs.mkdir(home, { recursive: true });
  const created = await mkdirNew(dir);
  // Every call fills in what is missing, so a slate left half-made by a crash is repaired, and
  // two sessions creating the same slate at once both find it whole.
  for (const f of SHARED) {
    try {
      await fs.writeFile(path.join(dir, f), TITLES[f], { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  await fs.mkdir(path.join(dir, 'reports'), { recursive: true });
  await fs.mkdir(path.join(dir, '.sessions'), { recursive: true });
  return { created, dir };
}

export async function createSession(slate, sessionId, pid) {
  const sessions = path.join(slate, '.sessions');
  await fs.mkdir(sessions, { recursive: true });
  const dir = path.join(sessions, sessionId);
  if (!(await mkdirNew(dir))) return { created: false, dir };
  await fs.mkdir(path.join(dir, 'queue'));
  await fs.writeFile(path.join(dir, 'now.md'), '');
  const data = { pid, created: new Date().toISOString(), from: null, turn: 0, seen: {} };
  await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify(data, null, 2) + '\n');
  return { created: true, dir };
}

async function subdirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

const mtime = async (p) => (await fs.stat(p).catch(() => null))?.mtimeMs ?? null;

export async function listSlates(home) {
  const out = [];
  for (const name of (await subdirs(home)).filter(validName)) {
    const dir = slateDir(home, name);
    let lastUsed = null;
    for (const id of await subdirs(path.join(dir, '.sessions'))) {
      const t = await mtime(path.join(dir, '.sessions', id, 'session.json'));
      if (t !== null && (lastUsed === null || t > lastUsed)) lastUsed = t;
    }
    out.push({ name, dir, lastUsed: lastUsed ?? (await mtime(dir)) ?? 0 });
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

// Every linked session folder in every slate; detached ones (set aside by /slate:done) are not.
export async function sessionDirs(home) {
  const out = [];
  for (const name of (await subdirs(home)).filter(validName)) {
    const sessions = path.join(slateDir(home, name), '.sessions');
    for (const id of await subdirs(sessions)) {
      if (!id.includes(DETACHED)) out.push(path.join(sessions, id));
    }
  }
  return out;
}

export async function findSession(home, sessionId) {
  for (const dir of await sessionDirs(home)) {
    if (path.basename(dir) !== sessionId) continue;
    if (await mtime(path.join(dir, 'session.json')) !== null) return dir;
  }
  return null;
}

const MAX_IDLE_MS = 30 * 24 * 3600 * 1000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Deletes session folders (detached ones too) not touched for maxIdleMs whose process is gone.
// Only readdir, stat and one small read per old folder: it runs at every startup.
export async function sweepSessions(home, { now = Date.now(), maxIdleMs = MAX_IDLE_MS, keep = null } = {}) {
  const deleted = [];
  for (const name of (await subdirs(home)).filter(validName)) {
    const sessions = path.join(slateDir(home, name), '.sessions');
    for (const id of await subdirs(sessions)) {
      const dir = path.join(sessions, id);
      if (dir === keep) continue;
      const file = path.join(dir, 'session.json');
      const t = await mtime(file);
      if (t === null || t >= now - maxIdleMs) continue;
      let pid = null;
      try {
        pid = JSON.parse(await fs.readFile(file, 'utf8')).pid ?? null;
      } catch {}
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
      try {
        await fs.rm(dir, { recursive: true, force: true });
        deleted.push(dir);
      } catch {}
    }
  }
  return deleted;
}

// The real location of p: symlinks resolved in its deepest existing part, the rest appended.
// null when a symlink on the way dangles, since a write through it would land somewhere unseen.
function realish(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail.reverse());
    } catch {
      try {
        lstatSync(cur);
        return null;
      } catch {}
      const up = path.dirname(cur);
      if (up === cur) return null;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

const under = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// 'allow' when the tool only touches the session's slate: reads anywhere in it, writes in reports/.
// The path is judged by where it really points, not how it is spelled.
export function slateAccess(toolName, toolInput, sessionDir) {
  const writes = toolName === 'Write' || toolName === 'Edit';
  const key = toolName === 'Read' || writes ? 'file_path' : toolName === 'Grep' || toolName === 'Glob' ? 'path' : null;
  const given = key && toolInput?.[key];
  if (typeof given !== 'string' || given === '') return null;
  const slate = slateOf(sessionDir);
  const target = path.resolve(given);
  const real = realish(target);
  if (real === null) return null;
  const base = writes ? path.join(slate, 'reports') : slate;
  const roots = [path.resolve(base), realish(path.resolve(base))].filter(Boolean);
  return roots.some((r) => under(real, r)) ? 'allow' : null;
}
