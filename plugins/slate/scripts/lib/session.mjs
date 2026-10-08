import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MEMORY_FILES } from './items.mjs';

const TITLES = {
  'instructions.md': '# Instructions\n',
  'assumptions.md': '# Assumptions\n',
  'facts.md': '# Facts\n',
  'now.md': '',
  'superseded.md': '# Superseded\n',
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd;
}

export function sessionDir(root, sessionId) {
  return path.join(root, '.slate', sessionId);
}

let tmpSeq = 0;
async function atomicWrite(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function initSession(root, sessionId, pid) {
  const slate = path.join(root, '.slate');
  const fresh = await fs.mkdir(slate, { recursive: true }); // path if created, else undefined
  if (fresh !== undefined) await fs.writeFile(path.join(slate, '.gitignore'), '*\n');
  const dir = sessionDir(root, sessionId);
  try {
    await fs.mkdir(dir);
  } catch (e) {
    if (e.code === 'EEXIST') return { created: false, dir };
    throw e;
  }
  await fs.mkdir(path.join(dir, 'conversation'));
  await fs.mkdir(path.join(dir, 'reports'));
  for (const f of MEMORY_FILES) await fs.writeFile(path.join(dir, f), TITLES[f]);
  await writeSession(dir, { pid, created: new Date().toISOString(), from: null, turn: 0, seen: {} });
  return { created: true, dir };
}

export async function readSession(dir) {
  const s = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8'));
  // Unknown fields (e.g. inject's logSeen) pass through, so read-modify-write callers keep them.
  return {
    ...s,
    pid: s.pid ?? null,
    created: s.created ?? null,
    from: s.from ?? null,
    turn: s.turn ?? 0,
    seen: s.seen ?? {},
  };
}

export async function writeSession(dir, data) {
  await atomicWrite(path.join(dir, 'session.json'), JSON.stringify(data, null, 2) + '\n');
}

export async function setPid(dir, pid) {
  const s = await readSession(dir);
  s.pid = pid;
  await writeSession(dir, s);
}

// Several folders can share a pid (/branch keeps it); the most recently written session.json wins.
export async function findByPid(root, pid) {
  const slate = path.join(root, '.slate');
  let names;
  try {
    names = await fs.readdir(slate);
  } catch {
    return null;
  }
  let best = null;
  let bestTime = -Infinity;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(slate, name);
    try {
      const s = await readSession(dir);
      if (s.pid !== pid) continue;
      const { mtimeMs } = await fs.stat(path.join(dir, 'session.json'));
      if (mtimeMs > bestTime) {
        best = dir;
        bestTime = mtimeMs;
      }
    } catch {}
  }
  return best;
}

export async function moveSession(fromDir, toDir) {
  await fs.rename(fromDir, toDir);
  const s = await readSession(toDir);
  s.from = path.basename(fromDir);
  await writeSession(toDir, s);
}

export async function copySession(fromDir, toDir, pid) {
  await fs.cp(fromDir, toDir, { recursive: true, errorOnExist: true, force: false });
  await fs.rm(path.join(toDir, 'curator.lock'), { force: true });
  const s = await readSession(toDir);
  s.pid = pid;
  s.from = path.basename(fromDir);
  await writeSession(toDir, s);
}

function psField(field, pid) {
  return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function claudePid() {
  const env = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(env) && env > 0) return env;
  // Fallback: first non-shell ancestor.
  let pid = process.ppid;
  for (let i = 0; i < 32 && Number.isInteger(pid) && pid > 1; i++) {
    try {
      const comm = psField('comm', pid);
      const base = path.basename(comm).replace(/^-/, '');
      if (!comm) return null;
      if (!SHELLS.has(base)) return pid;
      pid = Number(psField('ppid', pid));
    } catch {
      return null;
    }
  }
  return null;
}

export async function nextTurn(dir) {
  const s = await readSession(dir);
  s.turn += 1;
  await writeSession(dir, s);
  return s.turn;
}

// Turn files. A marker is a line that is exactly the marker text. Marker-like lines inside
// user or model text get one leading backslash on write, removed on read.
const MARKER_MESSAGE = '<!-- slate:message -->';
const MARKER_ANSWER = '<!-- slate:answer -->';
const ESCAPE_LINE = /^(\\*)(<!-- slate:(?:message|answer) -->)$/gm;
const UNESCAPE_LINE = /^\\(\\*<!-- slate:(?:message|answer) -->)$/gm;
const MARKER_LINE = /^<!-- slate:(message|answer) -->$/gm;

const escapeText = (t) => String(t).replace(ESCAPE_LINE, '\\$1$2');
const unescapeText = (t) => t.replace(UNESCAPE_LINE, '$1');

function turnFile(dir, turn) {
  return path.join(dir, 'conversation', `${String(turn).padStart(4, '0')}.md`);
}

export async function writeMessage(dir, turn, message, at = new Date().toISOString()) {
  const text = `# Turn ${turn} (${at})\n\n${MARKER_MESSAGE}\n${escapeText(message)}\n`;
  await atomicWrite(turnFile(dir, turn), text);
}

export async function appendAnswer(dir, turn, answer) {
  const file = turnFile(dir, turn);
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await atomicWrite(file, `${existing}${MARKER_ANSWER}\n${escapeText(answer)}\n`);
}

// A follow-up answer (e.g. after a background-agent notification) is just another answer section.
export const appendContinuation = appendAnswer;

export async function readTurn(dir, turn) {
  let text;
  try {
    text = await fs.readFile(turnFile(dir, turn), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { message: '', answer: '' };
    throw e;
  }
  const marks = [...text.matchAll(MARKER_LINE)].map((m) => ({
    kind: m[1], start: m.index, bodyStart: m.index + m[0].length + 1,
  }));
  let message = '';
  const answers = [];
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    let body = text.slice(Math.min(mk.bodyStart, end), end);
    if (body.endsWith('\n')) body = body.slice(0, -1);
    body = unescapeText(body);
    if (mk.kind === 'message' && i === 0) message = body;
    else if (mk.kind === 'answer') answers.push(body);
  });
  return { message, answer: answers.join('\n\n') };
}

export async function readMemory(dir) {
  const out = {};
  for (const f of MEMORY_FILES) {
    try {
      out[f] = await fs.readFile(path.join(dir, f), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      out[f] = '';
    }
  }
  return out;
}

export async function writeMemory(dir, files) {
  for (const f of Object.keys(files)) {
    if (!MEMORY_FILES.includes(f)) throw new Error(`not a memory file: ${f}`);
  }
  for (const [f, text] of Object.entries(files)) await atomicWrite(path.join(dir, f), text);
}
