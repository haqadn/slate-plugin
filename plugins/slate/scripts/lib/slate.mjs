// Shared slate layout: <home>/<name>/ holds the shared files; .sessions/<id>/ holds one session's.
import fs from 'node:fs/promises';
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
  if (!(await mkdirNew(dir))) return { created: false, dir };
  for (const f of SHARED) await fs.writeFile(path.join(dir, f), TITLES[f]);
  await fs.mkdir(path.join(dir, 'reports'));
  await fs.mkdir(path.join(dir, '.sessions'));
  return { created: true, dir };
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
