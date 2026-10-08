import fs from 'node:fs/promises';
import path from 'node:path';
import { ITEM_FILES, MEMORY_FILES, parseMemoryFile, formatItem } from './items.mjs';
import { readSession, writeSession, readMemory } from './session.mjs';

// Nothing here ever puts superseded.md text into output. Retired texts are read only to filter lines out.

const MAX = 10000; // SessionStart / UserPromptSubmit additionalContext cap
const RULES_FILE = new URL('../../rules.md', import.meta.url);
const COMPACT_LINE = 'Memory below wins where it differs from the summary.';
const REMINDER = 'slate: offload heavy reads to slate:offload; reply briefly.';
const MAX_ADDS = 5;
const MAX_WARNINGS = 5;
const WARNING_CHARS = 200; // before the "(see …curator.log)" tail
// Change-line order: as in the memory block (instructions, facts, assumptions).
const TYPE_ORDER = ['I', 'F', 'A'];
// Any line with a retired-style tag, however mangled, carries retired text; keep it out.
const RETIRED_LIKE = /\[[IAF]\d+\b[^\]]*\bretired\b/i;
const LOG_LINE = /^\S+ (t\d+) (restored|error)(?::(.*))?$/;
const ID_TOKEN = /\b[IAF]\d+\b/g;
// Violation kinds (from check.mjs messages) a warning may name. Only these labels are echoed.
const KINDS = [
  [/retired line outside superseded\.md/, 'retired line misplaced'],
  [/live item in superseded\.md/, 'live item in superseded.md'],
  [/superseded\.md lost line/, 'superseded line lost'],
  [/plain line lost/, 'plain line lost'],
  [/heading lost/, 'heading lost'],
  [/\breworded\b/, 'reworded'],
  [/\bdeleted\b/, 'deleted'],
  [/\bretired at t\d+/, 'wrong retire turn'],
  [/retired without reason/, 'no retire reason'],
  [/\bduplicated\b/, 'duplicated'],
  [/not above previous max/, 'ID not above max'],
  [/\btagged t\d+/, 'wrong turn tag'],
  [/malformed item line/, 'malformed line'],
  [/\.md missing\b/, 'file missing'],
  [/now\.md has \d+ lines/, 'now.md too long'],
];

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function rulesText(dir) {
  const text = await fs.readFile(RULES_FILE, 'utf8');
  return dir === undefined ? text : text.replaceAll('{{dir}}', () => dir);
}

function liveItems(memory) {
  const out = {};
  for (const type of TYPE_ORDER) out[type] = parseMemoryFile(memory[ITEM_FILES[type]]).items;
  return out;
}

function seenOf(items) {
  const seen = {};
  for (const type of TYPE_ORDER) for (const it of items[type]) seen[it.id] = it.text;
  return seen;
}

// Full texts of every retired item, wherever its line sits.
function retiredTexts(memory) {
  const out = new Set();
  for (const f of MEMORY_FILES) {
    for (const r of parseMemoryFile(memory[f]).retired) if (r.text.trim()) out.add(r.text.trim());
  }
  return [...out];
}

// A non-item line is safe if it has no retired-style tag and holds no retired item's text.
const safeText = (retired) => (l) => !RETIRED_LIKE.test(l) && !retired.some((t) => l.includes(t));

// Live lines of an item file: items with their IDs, then plain (hand-written) lines.
function liveLines(text, retired) {
  const p = parseMemoryFile(text);
  return [...p.items.map(formatItem).filter((l) => !RETIRED_LIKE.test(l)), ...p.plain.filter(safeText(retired))];
}

// now.md is free text: every non-blank line, in order, headings included.
const nowLines = (text, retired) =>
  String(text).split(/\r?\n/).filter((l) => l.trim() !== '').filter(safeText(retired));

export async function memoryBlock(dir, { afterCompact = false } = {}) {
  const memory = await readMemory(dir);
  const head = afterCompact ? `# slate memory\n${COMPACT_LINE}` : '# slate memory';
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
  const byFile = Object.fromEntries(sections.map((s) => [s.file, s]));
  const render = () =>
    [head, rules, ...sections.filter((s) => s.body).map((s) => `# ${s.title}\n${s.body}`)].join('\n\n');
  const where = (s) => path.join(dir, s.file);

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
  session.seen = seenOf(liveItems(memory));
  await writeSession(dir, session);
  return out;
}

// One warning line from known-safe tokens only: turn, status, ID tokens, violation kinds.
// Free text from the log is never echoed; it can quote superseded.md in any form.
function warningLine(turn, status, detail, log) {
  const ids = [...new Set(detail.match(ID_TOKEN) ?? [])].slice(0, 10);
  const kinds = KINDS.map(([re, label]) => [detail.search(re), label])
    .filter(([at]) => at >= 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, label]) => label);
  const what = [ids.join(' '), [...new Set(kinds)].join(', ')].filter(Boolean).join('; ');
  return `slate warning: ${clip(`${turn} ${status}${what ? `: ${what}` : ''}`, WARNING_CHARS)} (see ${log})`;
}

// curator.log lines `<ISO> t<N> <status>: <detail>` not yet shown, restored/error only.
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

  // While the curator runs, memory files hold unchecked edits that may be restored: diff later.
  if (!waiting) {
    const items = liveItems(await readMemory(dir));
    const live = seenOf(items);
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
      const [first, ...rest] = [...hidden];
      entries.push(`+${more} more (see ${[path.join(dir, first), ...rest].join(', ')})`);
    }
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
