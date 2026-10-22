import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MEMORY_FILES } from './items.mjs';
import { sessionDirs, memoryPath, slateOf } from './slate.mjs';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);

let tmpSeq = 0;
export async function atomicWrite(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
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
export async function findByPid(home, pid) {
  let best = null;
  let bestTime = -Infinity;
  for (const dir of await sessionDirs(home)) {
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

// Sets pid to null in every folder holding it, except `keep`. A process that switched to another
// session (in-process /resume) must not leave its pid on an old folder, or a later /clear or
// /branch would move or copy that folder into the wrong session.
export async function releasePid(home, pid, keep = null) {
  for (const dir of await sessionDirs(home)) {
    if (dir === keep) continue;
    try {
      const s = await readSession(dir);
      if (s.pid === pid) await writeSession(dir, { ...s, pid: null });
    } catch {}
  }
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

// `fields` (e.g. lastKind) go into the same session.json write; they can't set the turn.
export async function nextTurn(dir, fields = {}) {
  const s = await readSession(dir);
  const turn = s.turn + 1;
  await writeSession(dir, { ...s, ...fields, turn });
  return turn;
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

// Turn files are the curator's queue: drain deletes each once it's curated and a newer turn exists.
export function queueFile(dir, turn) {
  return path.join(dir, 'queue', `${String(turn).padStart(4, '0')}.md`);
}

// A folder from before queue/ existed has none.
const ensureQueue = (dir) => fs.mkdir(path.join(dir, 'queue'), { recursive: true });

export async function writeMessage(dir, turn, message, at = new Date().toISOString()) {
  const text = `# Turn ${turn} (${at})\n\n${MARKER_MESSAGE}\n${escapeText(message)}\n`;
  await ensureQueue(dir);
  await atomicWrite(queueFile(dir, turn), text);
}

export async function appendAnswer(dir, turn, answer) {
  const file = queueFile(dir, turn);
  await ensureQueue(dir);
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

// Deletes the queue files of turns 1..upTo.
export async function sweepQueue(dir, upTo) {
  let names;
  try {
    names = await fs.readdir(path.join(dir, 'queue'));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const name of names) {
    const m = /^(\d+)\.md$/.exec(name);
    if (m && Number(m[1]) <= upTo) await fs.rm(path.join(dir, 'queue', name), { force: true });
  }
}

// null if the turn file is missing. `size` is in bytes; `answered` means a Stop wrote an answer
// section (possibly empty). Escaped marker-like lines in the text don't count.
export async function turnState(dir, turn) {
  let buf;
  try {
    buf = await fs.readFile(queueFile(dir, turn));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const answered = [...buf.toString('utf8').matchAll(MARKER_LINE)].some((m) => m[1] === 'answer');
  return { size: buf.length, answered };
}

// curated.json `{ turn, size, retry? }`: the last turn curated and its turn file's size when it was
// read, plus a turn whose curation errored once (see drain in curate.mjs, the only writer).
export async function readCurated(dir) {
  try {
    const c = JSON.parse(await fs.readFile(path.join(dir, 'curated.json'), 'utf8'));
    if (Number.isInteger(c?.turn) && c.turn >= 0 && Number.isInteger(c.size) && c.size >= 0) {
      const retry = Number.isInteger(c.retry) && c.retry >= 1 ? { retry: c.retry } : {};
      return { turn: c.turn, size: c.size, ...retry };
    }
  } catch {}
  return { turn: 0, size: 0 };
}

// The turns memory does not cover yet, `{ from, to }`, or null when curation has caught up. A turn
// counts once its message is written; a continuation appended to the last curated turn reopens it.
export async function pendingTurns(dir) {
  const last = (await readSession(dir)).turn;
  const done = await readCurated(dir);
  let from = done.turn + 1;
  if (done.turn >= 1) {
    const st = await turnState(dir, done.turn);
    if (st && st.size > done.size) from = done.turn;
  }
  return from <= last ? { from, to: last } : null;
}

export async function readTurn(dir, turn) {
  let text;
  try {
    text = await fs.readFile(queueFile(dir, turn), 'utf8');
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

// <slate>/offloads.md: one entry per offload run, appended in a single write. Every return line is
// quoted with `>`, so return text can never start an entry of its own. The first entry is linked
// into place together with the title, so two first entries can't both write it.
export async function appendOffload(dir, { turn, at, agentId, transcript, text }) {
  const file = path.join(slateOf(dir), 'offloads.md');
  const where = typeof transcript === 'string' && transcript.trim()
    ? transcript.replace(/\s*[\r\n]+\s*/g, ' ').trim()
    : 'none';
  const body = text ? text.split(/\r?\n/).map((l) => (l ? `> ${l}` : '>')).join('\n') : '> (no return text)';
  const entry = `## t${turn}@${path.basename(dir).slice(0, 8)} ${at} ${agentId}\ntranscript: ${where}\n\n${body}\n\n`;
  const tmp = path.join(slateOf(dir), `.offloads.${process.pid}.${tmpSeq++}.tmp`);
  try {
    await fs.writeFile(tmp, `# Offloads\n\n${entry}`);
    await fs.link(tmp, file);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    await fs.appendFile(file, entry);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function readMemory(dir) {
  const out = {};
  for (const f of MEMORY_FILES) {
    try {
      out[f] = await fs.readFile(memoryPath(dir, f), 'utf8');
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
  for (const [f, text] of Object.entries(files)) await atomicWrite(memoryPath(dir, f), text);
}
