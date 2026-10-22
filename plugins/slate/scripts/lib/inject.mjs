import fs from 'node:fs/promises';
import path from 'node:path';
import { ITEM_FILES, MEMORY_FILES, RETIRED_LIKE, parseMemoryFile, formatItem } from './items.mjs';
import { readSession, writeSession, readMemory, pendingTurns } from './session.mjs';
import { memoryPath, slateOf, readTopics, topicPath } from './slate.mjs';
import { ERROR_KINDS } from './apply.mjs';

// Nothing here ever puts superseded.md text into output. Retired texts are read only to filter lines out.

const MAX = 10000; // SessionStart / UserPromptSubmit additionalContext cap
const RULES_FILE = new URL('../../rules.md', import.meta.url);
const COMPACT_LINE = 'Memory below wins where it differs from the summary.';
const REMINDER = 'slate: offload heavy reads to slate:offload; reply briefly.';
const MAX_ADDS = 5;
const MAX_TOPICS = 3; // topics named in a change line
const MAX_WARNINGS = 5;
const WARNING_CHARS = 200; // before the "(see …curator.log)" tail
// Change-line order: as in the memory block (instructions, facts, assumptions).
const TYPE_ORDER = ['I', 'F', 'A'];
const LOG_LINE = /^\S+ (t\d+) (partial|error)(?::(.*))?$/;
// Error kinds of apply.mjs tokens (`<op index>:<kind>[ <ID>]`). A warning echoes only these fixed
// labels, plus a stale token's ID, and only from text outside quotes.
const KINDS = [
  [/(?<![\w-])\d+:stale ([IAF]\d+)(?!\w)/g, (m) => `stale ${m[1]}`],
  ...ERROR_KINDS.map((k) => [new RegExp(`(?<![\\w-])\\d+:${k}(?![\\w-])`, 'g'), () => k]),
];
const QUOTES = new Map([['"', '"'], ["'", "'"], ['`', '`'], ['\u201c', '\u201d'], ['\u201d', '\u201d'],
  ['\u2018', '\u2019'], ['\u2019', '\u2019']]);

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function rulesText(dir) {
  const text = await fs.readFile(RULES_FILE, 'utf8');
  if (dir === undefined) return text;
  return text.replaceAll('{{slate}}', () => slateOf(dir)).replaceAll('{{session}}', () => dir);
}

function liveItems(memory) {
  const out = {};
  for (const type of TYPE_ORDER) out[type] = parseMemoryFile(memory[ITEM_FILES[type]]).items;
  return out;
}

// What a session has been shown: each key item's text, and each topic item's ID (null: a topic
// item's text is never shown).
function seenOf(items, topics) {
  const seen = {};
  for (const t of topics) for (const it of t.items) seen[it.id] = null;
  for (const type of TYPE_ORDER) for (const it of items[type]) seen[it.id] = it.text;
  return seen;
}

// Comparable form of a free line: no quote marker, bullet, checkbox, trailing reason or wrapping
// emphasis/code; whitespace collapsed; lowercase.
function norm(line) {
  let t = String(line).trim()
    .replace(/^(>\s*)+/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]?\]\s*/, '');
  for (let prev; prev !== t;) {
    prev = t;
    t = t.replace(/\s*\(reason:.*\)$/, '').trim();
    const m = /^(~~|\*\*|\*|_|`+)([\s\S]*)\1$/.exec(t);
    if (m && m[2].trim()) t = m[2].trim();
  }
  return t.replace(/\s+/g, ' ').toLowerCase();
}

// Normalised texts of every retired item, wherever its line sits.
function retiredTexts(memory) {
  const out = new Set();
  for (const f of MEMORY_FILES) {
    for (const r of parseMemoryFile(memory[f]).retired) {
      const t = norm(r.text);
      if (t) out.add(t);
    }
  }
  return out;
}

// A non-item line is safe unless it has a retired-style tag or is a copy of a retired item.
const safeText = (retired) => (l) => !RETIRED_LIKE.test(l) && !retired.has(norm(l));

// Live lines of an item file: items with their IDs, then plain (hand-written) lines.
function liveLines(text, retired) {
  const p = parseMemoryFile(text);
  return [...p.items.map(formatItem).filter((l) => !RETIRED_LIKE.test(l)), ...p.plain.filter(safeText(retired))];
}

// One topic index line, `- <slug>.md — <title>: <summary> (<count>)`, the file named within the
// topics folder the index names once. `summary` false leaves the summary out. A title or summary
// carrying retired text is left out, and the line is just the file and count.
const indexLine = (safe, summary) => (t) => {
  const label = [t.title, t.summary].filter(Boolean).every(safe)
    ? ` — ${t.title}${summary && t.summary ? `: ${t.summary}` : ''}`
    : '';
  return `- ${t.slug}.md${label} (${t.items.length})`;
};

// now.md is free text: every non-blank line, in order, headings included.
const nowLines = (text, retired) =>
  String(text).split(/\r?\n/).filter((l) => l.trim() !== '').filter(safeText(retired));

// One line when memory may lag the conversation: turns not curated yet (say a /clear aborted the
// curator), or `waiting`, a curator still holding the lock. The conversation is gone after a
// /clear, so the line points at the queued turn files. The drain may delete them once curated,
// hence the line's tail.
async function lagLine(dir, waiting) {
  const p = await pendingTurns(dir);
  if (!p) return waiting ? 'slate: memory still updating.' : '';
  const file = (t) => `${String(t).padStart(4, '0')}.md`;
  const conv = path.join(dir, 'queue');
  const what = p.from === p.to
    ? `turn ${p.to} yet — read ${path.join(conv, file(p.to))}`
    : `turns ${p.from}–${p.to} yet — read ${path.join(conv, file(p.from))} to ${file(p.to)}`;
  return `slate: ${waiting ? 'memory still updating; it' : 'memory'} may not include ${what} before acting on recent instructions; a file that's gone was curated since, so reread the memory files.`;
}

export async function memoryBlock(dir, { afterCompact = false, waiting = false } = {}) {
  const memory = await readMemory(dir);
  const topics = await readTopics(slateOf(dir));
  const lag = await lagLine(dir, waiting);
  const head = ['# slate memory', afterCompact && COMPACT_LINE, lag].filter(Boolean).join('\n');
  const rules = (await rulesText(dir)).trim();
  const retired = retiredTexts(memory);
  const sections = [
    ['Instructions', 'instructions.md'],
    ['Now', 'now.md'],
    ['Facts', 'facts.md'],
    ['Assumptions', 'assumptions.md'],
  ].map(([title, file]) => {
    const lines = file === 'now.md' ? nowLines(memory[file], retired) : liveLines(memory[file], retired);
    return { title, file, lines, body: lines.join('\n') };
  });
  // The topics folder once, then a line per topic file.
  const topicIndex = (summary) => (topics.length
    ? [`Topic files, in ${path.join(slateOf(dir), 'topics')}/:`, ...topics.map(indexLine(safeText(retired), summary))].join('\n')
    : '');
  sections.push({ title: 'Topics', file: 'topics', body: topicIndex(true) });
  const byFile = Object.fromEntries(sections.map((s) => [s.file, s]));
  const render = () =>
    [head, rules, ...sections.filter((s) => s.body).map((s) => `# ${s.title}\n${s.body}`)].join('\n\n');
  const where = (s) => memoryPath(dir, s.file);

  // Over budget: the topic index shrinks first, to titles (no summaries), then to slugs and counts;
  // then facts and assumptions spill.
  if (render().length > MAX) byFile.topics.body = topicIndex(false);
  if (render().length > MAX && topics.length) {
    const each = topicPath(slateOf(dir), '<slug>');
    const counts = topics.map((t) => `${t.slug} (${t.items.length})`).join(', ');
    byFile.topics.body = `${topics.length} topics, each in ${each}: ${counts}`;
  }
  for (const file of ['facts.md', 'assumptions.md']) {
    if (render().length <= MAX) break;
    const s = byFile[file];
    if (s.lines.length) s.body = `${s.lines.length} lines, too long to show; read ${where(s)} when needed.`;
  }
  // Still over: keep the first lines that fit and point at the file for the rest.
  for (const file of ['now.md', 'instructions.md']) {
    if (render().length <= MAX) break;
    const s = byFile[file];
    if (!s.lines.length) continue;
    s.body = '';
    const spare = MAX - render().length - `\n\n# ${s.title}\n`.length;
    const pointer = (n) => `… ${n} more; read ${where(s)}`;
    const kept = [];
    let used = pointer(s.lines.length).length;
    for (const line of s.lines) {
      if (used + line.length + 1 > spare) break;
      kept.push(line);
      used += line.length + 1;
    }
    s.body = [...kept, pointer(s.lines.length - kept.length)].join('\n');
  }
  const out = clip(render(), MAX);

  const session = await readSession(dir);
  session.seen = seenOf(liveItems(memory), topics);
  await writeSession(dir, session);
  return out;
}

// Text with every quoted span blanked; an unclosed quote blanks the rest.
function outsideQuotes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const close = QUOTES.get(s[i]);
    if (close === undefined) {
      out += s[i];
      continue;
    }
    const j = s.indexOf(close, i + 1);
    out += ' ';
    if (j < 0) break;
    i = j;
  }
  return out;
}

// One warning line from known-safe tokens only: turn, status, error kinds (with their IDs).
// Free text from the log is never echoed; it can quote superseded.md in any form.
function warningLine(turn, status, detail, log) {
  const text = outsideQuotes(detail);
  const found = [];
  for (const [re, label] of KINDS) {
    for (const m of text.matchAll(re)) found.push([m.index, label(m)]);
  }
  const what = [...new Set(found.sort((a, b) => a[0] - b[0]).map(([, l]) => l))].join(', ');
  return `slate warning: ${clip(`${turn} ${status}${what ? `: ${what}` : ''}`, WARNING_CHARS)} (see ${log})`;
}

// curator.log lines `<ISO> t<N> <status>: <detail>` not yet shown, partial/error only.
// Only complete lines are consumed; session.logSeen holds the byte offset already read.
async function newWarnings(dir, session) {
  const log = path.join(dir, 'curator.log');
  let buf;
  try {
    buf = await fs.readFile(log);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  let start = Number.isInteger(session.logSeen) && session.logSeen >= 0 ? session.logSeen : 0;
  if (start > buf.length) start = 0; // log was replaced
  const end = buf.lastIndexOf(0x0a) + 1;
  if (end <= start) return [];
  session.logSeen = end;
  const out = [];
  for (const raw of buf.subarray(start, end).toString('utf8').split('\n')) {
    const m = LOG_LINE.exec(raw.replace(/\r$/, ''));
    if (m) out.push(warningLine(m[1], m[2], m[3] ?? '', log));
  }
  return out;
}

export async function changeLine(dir, { waiting = false } = {}) {
  const session = await readSession(dir);
  const entries = [];

  // While the curator runs, memory is about to change: diff later.
  if (!waiting) {
    const items = liveItems(await readMemory(dir));
    const topics = await readTopics(slateOf(dir));
    const live = seenOf(items, topics);
    const hidden = new Set();
    let shown = 0;
    let more = 0;
    for (const type of TYPE_ORDER) {
      for (const it of items[type]) {
        if (session.seen[it.id] === it.text) continue;
        // Text with a retired-style tag is never shown; the item goes to the "+N more" pointer.
        if (shown < MAX_ADDS && !RETIRED_LIKE.test(it.text)) {
          entries.push(`+${it.id} ${it.text}`);
          shown++;
        } else {
          more++;
          hidden.add(ITEM_FILES[type]);
        }
      }
      const gone = Object.keys(session.seen)
        .filter((id) => id.startsWith(type) && !(id in live))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      if (gone.length) entries.push(`retired ${gone.join(', ')}`);
    }
    if (more) {
      entries.push(`+${more} more (see ${[...hidden].map((f) => memoryPath(dir, f)).join(', ')})`);
    }
    // Topic items are counted, not shown: IDs never seen, by topic, the most first (ties by slug:
    // topics come sorted and the sort is stable). An ID seen anywhere before was moved, not added.
    const added = topics.map((t) => [t.slug, t.items.filter((it) => !(it.id in session.seen)).length])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    entries.push(...added.slice(0, MAX_TOPICS).map(([slug, n]) => `+${n} in ${slug}`));
    const rest = added.slice(MAX_TOPICS).reduce((sum, [, n]) => sum + n, 0);
    if (rest) entries.push(`+${rest} more`);
    session.seen = live;
  } else {
    entries.push('memory still updating');
  }

  const warnings = await newWarnings(dir, session);
  const lines = [REMINDER];
  if (entries.length) lines.push(`slate: ${entries.join(' · ')}`);
  lines.push(...warnings.slice(0, MAX_WARNINGS));
  if (warnings.length > MAX_WARNINGS) {
    lines.push(`slate warning: +${warnings.length - MAX_WARNINGS} more in ${path.join(dir, 'curator.log')}`);
  }

  await writeSession(dir, session);
  return clip(lines.join('\n'), MAX);
}
