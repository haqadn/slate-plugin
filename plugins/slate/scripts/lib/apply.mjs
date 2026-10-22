// The only writer of memory files. The curator returns a change list; this applies it under the
// slate's memory.lock: reread the files, adopt the user's plain bullets, check each operation
// against what's there now, then write each changed file atomically. A live line is never
// rewritten, only retired; superseded.md is only appended to; IDs are assigned here.
import fs from 'node:fs/promises';
import {
  ITEM_FILES, MEMORY_FILES, RETIRED_LIKE, parseItemLine, parseMemoryFile, formatItem, formatRetired,
} from './items.mjs';
import { readMemory, atomicWrite } from './session.mjs';
import { acquire } from './lock.mjs';
import { memoryPath, slateOf } from './slate.mjs';

const LOCK = 'memory.lock';
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;
const NOW_MAX_LINES = 10;
const TYPES = Object.keys(ITEM_FILES);
const ITEM_FILE_NAMES = Object.values(ITEM_FILES);
const SHARED = MEMORY_FILES.filter((f) => f !== 'now.md');
const ID = /^([IAF])(\d+)$/;
const ITEM_TAG = /\[[IAF]\d+ t\d+/;
const SESSION8 = /^[A-Za-z0-9._-]{1,8}$/;
// A user's own bullet: `- text`, not an item-looking or retired-looking line.
const PLAIN_BULLET = /^- (?!\[[IAF]\d)(?=\S)/;
const REPORT = /(?:^|[^\w.-])reports\/|\.slate/;

const STRING = { type: 'string' };
function shape(op, fields) {
  return {
    type: 'object',
    properties: { op: { const: op }, ...fields },
    required: ['op', ...Object.keys(fields)],
    additionalProperties: false,
  };
}

// Each op is closed: given the chance, the model puts an `id` on an `add`.
export const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        oneOf: [
          shape('add', { type: { type: 'string', enum: TYPES }, text: STRING }),
          shape('retire', { id: STRING, reason: STRING }),
          shape('replace', { id: STRING, text: STRING, reason: STRING }),
          shape('now', { text: STRING }),
        ],
      },
    },
  },
  required: ['ops'],
  additionalProperties: false,
};

async function lockMemory(slate) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = await acquire(slate, LOCK);
    if (release) return release;
    if (Date.now() >= deadline) throw new Error(`${LOCK} busy`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

// A file as raw lines, so untouched lines (and their \r) are written back byte for byte.
const load = (text) => ({ lines: text.split('\n'), changed: false });
const bare = (raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw);

function append(file, line) {
  const { lines } = file;
  if (lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line);
  else lines.push(line, '');
  file.changed = true;
}

// The source of a fact: what's inside the parentheses that close its text, nesting allowed.
function sourceOf(text) {
  const t = text.trimEnd();
  if (!t.endsWith(')')) return null;
  for (let i = t.length - 1, depth = 0; i >= 0; i--) {
    if (t[i] === ')') depth++;
    else if (t[i] === '(' && --depth === 0) return t.slice(i + 1, -1);
  }
  return null;
}

function textError(type, text, slatePaths) {
  if (text.trim() === '') return 'empty text';
  if (/[\r\n]/.test(text)) return 'multi-line text';
  if (ITEM_TAG.test(text) || RETIRED_LIKE.test(text)) return 'tag in text';
  if (type !== 'F') return null;
  const source = sourceOf(text)?.trim();
  if (!source) return 'no source';
  if (REPORT.test(source) || slatePaths.some((p) => source.includes(p))) return 'report source';
  return null;
}

function reasonError(reason) {
  if (reason.trim() === '') return 'empty reason';
  if (/[\r\n]/.test(reason)) return 'multi-line reason';
  return null;
}

function nowError(text) {
  if (text.split(/\r?\n/).filter((l) => l.trim() !== '').length > NOW_MAX_LINES) return 'now too long';
  if (ITEM_TAG.test(text) || RETIRED_LIKE.test(text)) return 'tag in now';
  return null;
}

const isString = (...xs) => xs.every((x) => typeof x === 'string');

// Applies `ops` to the memory of session folder `dir`. Strict: any error means nothing is
// written. Lenient: invalid ops are dropped, and a stale replace still adds its new item, so a
// user's instruction is never silently lost. Returned tokens carry op index, kind and IDs only.
export async function applyChanges(dir, ops, { turn, sessionId, lenient = false }) {
  if (!Array.isArray(ops)) throw new TypeError('ops is not a list');
  if (!Number.isInteger(turn) || turn < 0) throw new TypeError(`bad turn: ${turn}`);
  const session = String(sessionId).slice(0, 8);
  if (!SESSION8.test(session)) throw new TypeError('bad session ID');
  await fs.access(dir); // a deleted slate throws here; nothing below creates a folder
  const slate = slateOf(dir);
  const release = await lockMemory(slate);
  try {
    const text = await readMemory(dir);
    const mem = Object.fromEntries(MEMORY_FILES.map((f) => [f, load(text[f])]));
    const slatePaths = [slate, await fs.realpath(slate)];
    const applied = [];
    const skipped = [];
    const errors = [];

    const next = Object.fromEntries(TYPES.map((t) => [t, 1]));
    for (const f of SHARED) {
      const p = parseMemoryFile(text[f]);
      for (const x of [...p.items, ...p.retired]) next[x.type] = Math.max(next[x.type], x.num + 1);
    }
    const newId = (type) => `${type}${next[type]++}`;

    for (const type of TYPES) {
      const file = mem[ITEM_FILES[type]];
      file.lines.forEach((raw, i) => {
        const line = bare(raw);
        if (!PLAIN_BULLET.test(line) || RETIRED_LIKE.test(line)) return;
        const id = newId(type);
        file.lines[i] = formatItem({ id, turn: 0, text: line.slice(2) }) + raw.slice(line.length);
        file.changed = true;
        applied.push(`adopt ${id}`);
      });
    }

    const live = () => ITEM_FILE_NAMES.flatMap((f) => mem[f].lines
      .map((raw, index) => ({ file: mem[f], index, item: parseItemLine(bare(raw)) }))
      .filter((x) => x.item));
    // The new item's ID, or null when its text is already live (then it's reported as skipped).
    const add = (i, type, itemText) => {
      const dup = live().find((x) => x.item.text === itemText);
      if (dup) {
        skipped.push(`${i}:duplicate ${dup.item.id}`);
        return null;
      }
      const id = newId(type);
      append(mem[ITEM_FILES[type]], formatItem({ id, turn, session, text: itemText }));
      return id;
    };
    const retire = ({ file, index, item }, reason) => {
      file.lines.splice(index, 1);
      file.changed = true;
      append(mem['superseded.md'], formatRetired({
        ...item, retiredTurn: turn, retiredSession: session, reason: reason.trim(),
      }));
    };

    ops.forEach((o, i) => {
      const fail = (kind, id) => errors.push(`${i}:${kind}${id ? ` ${id}` : ''}`);
      if (o === null || typeof o !== 'object') return fail('bad op');
      if (o.op === 'add') {
        if (!TYPES.includes(o.type) || !isString(o.text)) return fail('bad op');
        const bad = textError(o.type, o.text, slatePaths);
        if (bad) return fail(bad);
        const id = add(i, o.type, o.text);
        if (id) applied.push(`${i}:add ${id}`);
      } else if (o.op === 'retire' || o.op === 'replace') {
        const replace = o.op === 'replace';
        if (!isString(o.id, o.reason) || (replace && !isString(o.text))) return fail('bad op');
        const m = ID.exec(o.id);
        if (!m) return fail('bad id');
        const id = m[1] + Number(m[2]);
        const bad = (replace && textError(m[1], o.text, slatePaths)) || reasonError(o.reason);
        if (bad) return fail(bad);
        const target = live().find((x) => x.item.id === id);
        if (!target) {
          fail('stale', id);
          if (replace && lenient) {
            const added = add(i, m[1], o.text);
            if (added) applied.push(`${i}:add ${added}`);
          }
          return;
        }
        retire(target, o.reason);
        const added = replace && add(i, m[1], o.text);
        applied.push(added ? `${i}:replace ${id} ${added}` : `${i}:retire ${id}`);
      } else if (o.op === 'now') {
        if (!isString(o.text)) return fail('bad op');
        const bad = nowError(o.text);
        if (bad) return fail(bad);
        mem['now.md'] = { ...load(o.text === '' || o.text.endsWith('\n') ? o.text : `${o.text}\n`), changed: true };
        applied.push(`${i}:now`);
      } else {
        fail('bad op');
      }
    });

    if (errors.length && !lenient) return { applied: [], skipped: [], errors };
    for (const f of MEMORY_FILES) {
      if (mem[f].changed) await atomicWrite(memoryPath(dir, f), mem[f].lines.join('\n'));
    }
    return { applied, skipped, errors };
  } finally {
    await release();
  }
}
