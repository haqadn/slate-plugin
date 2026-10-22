// The only writer of memory files. The curator returns a change list; this applies it under the
// slate's memory.lock: reread the files, adopt the user's plain bullets, check each operation
// against what's there now, then write each changed file atomically. A live line is never
// rewritten, only retired or moved; superseded.md is only appended to; IDs are assigned here.
// Facts and assumptions sit in a key file (what most sessions need on most turns) or in a topic
// file. usage.json records when each was last relevant; a key file over its cap moves its least
// recently relevant items to their home topics.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ITEM_FILES, MEMORY_FILES, RETIRED_LIKE, parseItemLine, parseMemoryFile, formatItem, formatRetired,
} from './items.mjs';
import { readMemory, atomicWrite } from './session.mjs';
import { acquire } from './lock.mjs';
import { memoryPath, slateOf, readTopics, topicPath, validTopic } from './slate.mjs';

const LOCK = 'memory.lock';
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;
const NOW_MAX_LINES = 10;
const USAGE = 'usage.json';
const KEY = 'key';
const GENERAL = { slug: 'general', title: 'General', summary: 'Items without a more specific topic.' };
export const FACTS_CAP = 3000;
export const ASSUMPTIONS_CAP = 1500;
// The total chars of item lines a key file may hold.
const CAPS = { 'facts.md': FACTS_CAP, 'assumptions.md': ASSUMPTIONS_CAP };
const TYPES = Object.keys(ITEM_FILES);
const TOPIC_TYPES = ['A', 'F'];
const ITEM_FILE_NAMES = Object.values(ITEM_FILES);
const SHARED = MEMORY_FILES.filter((f) => f !== 'now.md');
const ID = /^([IAF])(\d+)$/;
const ITEM_TAG = /\[[IAF]\d+ t\d+/;
const SESSION8 = /^[A-Za-z0-9._-]{1,8}$/;
// A user's own bullet: `- text`, not an item-looking or retired-looking line.
const PLAIN_BULLET = /^- (?!\[[IAF]\d)(?=\S)/;
const REPORT = /(?:^|[^\w.-])reports\/|\.slate/;
// Kinds of error token (`<op index>:<kind>`), besides `stale <ID>`. A warning echoes only these.
export const ERROR_KINDS = ['bad op', 'bad id', 'empty text', 'multi-line text', 'tag in text', 'no source',
  'report source', 'empty reason', 'multi-line reason', 'now too long', 'tag in now', 'bad slug', 'empty title',
  'multi-line title', 'empty summary', 'multi-line summary', 'missing topic', 'no home', 'instruction move'];

const STRING = { type: 'string' };
function shape(op, fields) {
  return {
    type: 'object',
    properties: { op: { const: op }, ...fields },
    required: ['op', ...Object.keys(fields)],
    additionalProperties: false,
  };
}

// Each op is closed: given the chance, the model puts an `id` on an `add`. An instruction is always
// a key item; a fact or assumption goes into a topic, or into its key file with a home topic.
const TOPIC_TYPE = { type: 'string', enum: TOPIC_TYPES };
export const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        oneOf: [
          shape('add', { type: { type: 'string', enum: ['I'] }, text: STRING }),
          shape('add', { type: TOPIC_TYPE, text: STRING, topic: STRING }),
          shape('add', { type: TOPIC_TYPE, text: STRING, home: STRING }),
          shape('retire', { id: STRING, reason: STRING }),
          shape('replace', { id: STRING, text: STRING, reason: STRING }),
          shape('now', { text: STRING }),
          shape('topic', { slug: STRING, title: STRING, summary: STRING }),
          shape('move', { id: STRING, to: STRING }),
        ],
      },
    },
    relevant: { type: 'array', items: STRING },
  },
  required: ['ops', 'relevant'],
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

// A one-line field: a reason, or a topic's title or summary.
function lineError(value, field) {
  if (value.trim() === '') return `empty ${field}`;
  if (/[\r\n]/.test(value)) return `multi-line ${field}`;
  return null;
}

function nowError(text) {
  if (text.split(/\r?\n/).filter((l) => l.trim() !== '').length > NOW_MAX_LINES) return 'now too long';
  if (ITEM_TAG.test(text) || RETIRED_LIKE.test(text)) return 'tag in now';
  return null;
}

const isString = (...xs) => xs.every((x) => typeof x === 'string');
const parseId = (s) => {
  const m = ID.exec(s);
  return m && m[1] + Number(m[2]);
};

// Sets a topic file's first two lines, `# <title>` and `> <summary>`; the rest stays byte for byte.
function setHeader(file, title, summary) {
  const head = [`# ${title}`, `> ${summary}`];
  const has = (i, re) => i < file.lines.length && re.test(bare(file.lines[i]));
  const n = has(0, /^# /) ? (has(1, /^>/) ? 2 : 1) : 0;
  if (n === 2 && file.lines[0] === head[0] && file.lines[1] === head[1]) return;
  file.lines.splice(0, n, ...head);
  file.changed = true;
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// usage.json: `{ "<ID>": { last: <ISO>, count, home: <slug> } }`. Only applyChanges writes it; a
// file it can't read starts afresh rather than block memory updates.
function parseUsage(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, u] of Object.entries(raw)) {
    if (!ID.test(id) || !u || typeof u !== 'object') continue;
    out[id] = {
      last: typeof u.last === 'string' ? u.last : undefined,
      count: Number.isInteger(u.count) && u.count >= 0 ? u.count : 0,
      home: typeof u.home === 'string' ? u.home : undefined,
    };
  }
  return out;
}

const byId = ([a], [b]) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1));
const formatUsage = (usage) => `${JSON.stringify(Object.fromEntries(Object.entries(usage).sort(byId)
  .map(([id, { last, count, home }]) => [id, { last, count, home }])), null, 2)}\n`;

// Applies `ops` to the memory of session folder `dir`, then records `relevant` (IDs of the facts
// and assumptions relevant to this turn) and enforces the key-file caps. Strict: any error means
// nothing is written. Lenient: invalid ops are dropped, and a stale replace still adds its new
// item, so a user's instruction is never silently lost. Returned tokens carry op index, kind, IDs
// and slugs only; `demoted` lists `<ID>><slug>` for each item a cap moved out of its key file.
export async function applyChanges(dir, ops, {
  turn, sessionId, lenient = false, relevant = [], now = new Date(),
}) {
  if (!Array.isArray(ops)) throw new TypeError('ops is not a list');
  if (!Number.isInteger(turn) || turn < 0) throw new TypeError(`bad turn: ${turn}`);
  const session = String(sessionId).slice(0, 8);
  if (!SESSION8.test(session)) throw new TypeError('bad session ID');
  const stamp = now.toISOString();
  await fs.access(dir); // a deleted slate throws here; nothing below creates a folder
  const slate = slateOf(dir);
  const release = await lockMemory(slate);
  try {
    const text = await readMemory(dir);
    const mem = Object.fromEntries(MEMORY_FILES.map((f) => [f, load(text[f])]));
    const found = await readTopics(slate);
    const topics = new Map(found.map((t) => [t.slug, load(t.text)]));
    const usageFile = path.join(slate, USAGE);
    const usageBefore = await readText(usageFile);
    const usage = parseUsage(usageBefore);
    const slatePaths = [slate, await fs.realpath(slate)];
    const applied = [];
    const skipped = [];
    const errors = [];
    const demoted = [];
    const fresh = new Set(); // IDs this list adds or promotes: stamped with `now`, never demoted

    const next = Object.fromEntries(TYPES.map((t) => [t, 1]));
    for (const t of [...SHARED.map((f) => text[f]), ...found.map((x) => x.text)]) {
      const p = parseMemoryFile(t);
      for (const x of [...p.items, ...p.retired]) next[x.type] = Math.max(next[x.type], x.num + 1);
    }
    const newId = (type) => `${type}${next[type]++}`;

    // A key file's bullets take its type; a topic file's are facts.
    const adopt = (file, type) => file.lines.forEach((raw, i) => {
      const line = bare(raw);
      if (!PLAIN_BULLET.test(line) || RETIRED_LIKE.test(line)) return;
      const id = newId(type);
      file.lines[i] = formatItem({ id, turn: 0, text: line.slice(2) }) + raw.slice(line.length);
      file.changed = true;
      applied.push(`adopt ${id}`);
    });
    for (const type of TYPES) adopt(mem[ITEM_FILES[type]], type);
    for (const file of topics.values()) adopt(file, 'F');

    const keyFile = (type) => mem[ITEM_FILES[type]];
    const hasTopic = (slug) => topics.has(slug) || slug === GENERAL.slug;
    const topicError = (slug) => (!validTopic(slug) ? 'bad slug' : !hasTopic(slug) ? 'missing topic' : null);
    const topicFile = (slug) => {
      if (!topics.has(slug)) { // only `general` is made on demand
        topics.set(slug, load(''));
        setHeader(topics.get(slug), GENERAL.title, GENERAL.summary);
      }
      return topics.get(slug);
    };
    // Every live item, with where it is: `key` or a topic's slug.
    const live = () => [...ITEM_FILE_NAMES.map((f) => [KEY, mem[f]]), ...topics]
      .flatMap(([where, file]) => file.lines.flatMap((raw, index) => {
        const line = bare(raw);
        const item = parseItemLine(line);
        return item ? [{ where, file, index, line, item }] : [];
      }));
    const find = (id) => live().find((x) => x.item.id === id);
    // The new item's ID, or null when its text is already live (then it's reported as skipped).
    // It goes into topic `slug`, or its key file when slug is null.
    const add = (i, type, itemText, slug) => {
      const dup = live().find((x) => x.item.text === itemText);
      if (dup) {
        skipped.push(`${i}:duplicate ${dup.item.id}`);
        return null;
      }
      const id = newId(type);
      append(slug ? topicFile(slug) : keyFile(type), formatItem({ id, turn, session, text: itemText }));
      fresh.add(id);
      return id;
    };
    const retire = ({ file, index, item }, reason) => {
      file.lines.splice(index, 1);
      file.changed = true;
      append(mem['superseded.md'], formatRetired({
        ...item, retiredTurn: turn, retiredSession: session, reason: reason.trim(),
      }));
    };
    const move = ({ file, index, line }, to) => {
      file.lines.splice(index, 1);
      file.changed = true;
      append(to, line);
    };

    const handle = (o, i) => {
      const fail = (kind, id) => errors.push(`${i}:${kind}${id ? ` ${id}` : ''}`);
      if (o === null || typeof o !== 'object') return fail('bad op');
      if (o.op === 'topic') {
        if (!isString(o.slug, o.title, o.summary)) return fail('bad op');
        if (!validTopic(o.slug)) return fail('bad slug');
        const bad = lineError(o.title, 'title') || lineError(o.summary, 'summary');
        if (bad) return fail(bad);
        if (!topics.has(o.slug)) topics.set(o.slug, load(''));
        setHeader(topics.get(o.slug), o.title.trim(), o.summary.trim());
        applied.push(`${i}:topic ${o.slug}`);
      } else if (o.op === 'add') {
        const { type, topic, home } = o;
        if (!TYPES.includes(type) || !isString(o.text)) return fail('bad op');
        if (![topic, home].every((x) => x === undefined || typeof x === 'string')) return fail('bad op');
        // An instruction names neither a topic nor a home; a fact or assumption names one of them.
        if (type === 'I' ? topic !== undefined || home !== undefined : topic !== undefined && home !== undefined) {
          return fail('bad op');
        }
        const slug = topic ?? home;
        const bad = textError(type, o.text, slatePaths)
          || (type !== 'I' && (slug === undefined ? 'no home' : topicError(slug)));
        if (bad) return fail(bad);
        const id = add(i, type, o.text, topic ?? null);
        if (!id) return;
        if (home !== undefined) usage[id] = { ...usage[id], home };
        applied.push(topic === undefined ? `${i}:add ${id}` : `${i}:add ${id}>${topic}`);
      } else if (o.op === 'retire' || o.op === 'replace') {
        const replace = o.op === 'replace';
        if (!isString(o.id, o.reason) || (replace && !isString(o.text))) return fail('bad op');
        const id = parseId(o.id);
        if (!id) return fail('bad id');
        const bad = (replace && textError(id[0], o.text, slatePaths)) || lineError(o.reason, 'reason');
        if (bad) return fail(bad);
        const target = find(id);
        if (!target) {
          fail('stale', id);
          if (replace && lenient) {
            const added = add(i, id[0], o.text, null);
            if (added) applied.push(`${i}:add ${added}`);
          }
          return;
        }
        retire(target, o.reason);
        // The replacement takes the old item's place: its file and its usage.
        const added = replace && add(i, id[0], o.text, target.where === KEY ? null : target.where);
        if (added && usage[id]) usage[added] = { ...usage[id] };
        applied.push(added ? `${i}:replace ${id} ${added}` : `${i}:retire ${id}`);
      } else if (o.op === 'move') {
        if (!isString(o.id, o.to)) return fail('bad op');
        const id = parseId(o.id);
        if (!id) return fail('bad id');
        if (id[0] === 'I') return fail('instruction move');
        const bad = o.to !== KEY && topicError(o.to);
        if (bad) return fail(bad);
        const target = find(id);
        if (!target) return fail('stale', id);
        if (o.to === KEY ? target.file === keyFile(id[0]) : target.where === o.to) {
          skipped.push(`${i}:in place ${id}`);
          return;
        }
        move(target, o.to === KEY ? keyFile(id[0]) : topicFile(o.to));
        if (o.to === KEY) {
          // Promoted: the topic it came from is its home.
          fresh.add(id);
          if (target.where !== KEY) usage[id] = { ...usage[id], home: target.where };
        }
        applied.push(`${i}:move ${id}>${o.to}`);
      } else if (o.op === 'now') {
        if (!isString(o.text)) return fail('bad op');
        const bad = nowError(o.text);
        if (bad) return fail(bad);
        mem['now.md'] = { ...load(o.text === '' || o.text.endsWith('\n') ? o.text : `${o.text}\n`), changed: true };
        applied.push(`${i}:now`);
      } else {
        fail('bad op');
      }
    };
    // Topic ops first, so any op in the list can use a topic the list creates.
    const isTopic = (i) => ops[i]?.op === 'topic';
    const order = [...ops.keys()];
    for (const i of [...order.filter(isTopic), ...order.filter((i) => !isTopic(i))]) handle(ops[i], i);

    if (errors.length && !lenient) return { applied: [], skipped: [], errors, demoted: [] };

    // Usage covers live facts and assumptions only.
    const tracked = new Set(live().map((x) => x.item.id).filter((id) => TOPIC_TYPES.includes(id[0])));
    const named = new Set((Array.isArray(relevant) ? relevant : []).filter((r) => typeof r === 'string').map(parseId));
    for (const id of named) {
      if (tracked.has(id)) usage[id] = { ...usage[id], last: stamp, count: (usage[id]?.count ?? 0) + 1 };
    }
    for (const id of fresh) {
      if (tracked.has(id)) usage[id] = { ...usage[id], last: stamp, count: usage[id]?.count ?? 0 };
    }
    for (const id of Object.keys(usage)) if (!tracked.has(id)) delete usage[id];

    // Caps: move the least recently relevant item out until the key file fits. No usage counts as
    // oldest; ties go to the lower count, then the lower ID.
    const lastOf = (id) => Date.parse(usage[id]?.last ?? '') || -Infinity;
    const countOf = (id) => usage[id]?.count ?? 0;
    for (const [f, cap] of Object.entries(CAPS)) {
      const inFile = () => live().filter((x) => x.file === mem[f]);
      let size = inFile().reduce((n, x) => n + x.line.length, 0);
      if (size <= cap) continue;
      const queue = inFile().map((x) => x.item)
        .filter((it) => TOPIC_TYPES.includes(it.type) && !fresh.has(it.id))
        .sort((a, b) => lastOf(a.id) - lastOf(b.id) || countOf(a.id) - countOf(b.id) || a.num - b.num);
      for (const { id } of queue) {
        if (size <= cap) break;
        const target = inFile().find((x) => x.item.id === id);
        const home = usage[id]?.home;
        const slug = home && topics.has(home) ? home : GENERAL.slug;
        move(target, topicFile(slug));
        size -= target.line.length;
        demoted.push(`${id}>${slug}`);
      }
    }

    const changedTopics = [...topics].filter(([, file]) => file.changed);
    if (changedTopics.length) {
      try {
        await fs.mkdir(path.join(slate, 'topics')); // not recursive: never recreates a deleted slate
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    // Topic files first, so a demotion cut short by a crash leaves its item in two files, not none.
    for (const [slug, file] of changedTopics) await atomicWrite(topicPath(slate, slug), file.lines.join('\n'));
    for (const f of MEMORY_FILES) {
      if (mem[f].changed) await atomicWrite(memoryPath(dir, f), mem[f].lines.join('\n'));
    }
    const usageAfter = formatUsage(usage);
    if (usageAfter !== usageBefore && (usageBefore !== '' || Object.keys(usage).length)) {
      await atomicWrite(usageFile, usageAfter);
    }
    return { applied, skipped, errors, demoted };
  } finally {
    await release();
  }
}
