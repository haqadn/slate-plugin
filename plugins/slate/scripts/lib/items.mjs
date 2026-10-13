export const ITEM_FILES = { I: 'instructions.md', A: 'assumptions.md', F: 'facts.md' };
export const MEMORY_FILES = ['instructions.md', 'assumptions.md', 'facts.md', 'now.md', 'superseded.md'];

const HEADING = /^#{1,6}(\s|$)/;
// A line that carries retired text: a retired-style tag, however mangled, or a free-form note
// naming a retired ID ("~~use npm~~ (retired I1)"). Never injected; new ones fail the check.
export const RETIRED_LIKE = /\[[IAF]\d+\b[^\]]*\bretired\b|\bretired\s+[IAF]\d+\b/i;
const ITEM = /^- \[([IAF])(\d+) t(\d+)\] (.*)$/;
const RETIRED = /^- \[([IAF])(\d+) t(\d+) retired t(\d+)\] (.*) \(reason: (.*)\)$/;

export function isHeading(line) {
  return HEADING.test(line);
}

export function parseItemLine(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  return { id: m[1] + Number(m[2]), type: m[1], num: Number(m[2]), turn: Number(m[3]), text: m[4] };
}

export function formatItem({ id, turn, text }) {
  return `- [${id} t${turn}] ${text}`;
}

export function parseRetiredLine(line) {
  const m = RETIRED.exec(line);
  if (!m) return null;
  return {
    id: m[1] + Number(m[2]), type: m[1], num: Number(m[2]), turn: Number(m[3]),
    retiredTurn: Number(m[4]), text: m[5], reason: m[6],
  };
}

export function formatRetired(r) {
  return `- [${r.id} t${r.turn} retired t${r.retiredTurn}] ${r.text} (reason: ${r.reason})`;
}

// Headings (including the file title) land in no list.
export function parseMemoryFile(text) {
  const out = { items: [], retired: [], plain: [] };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (isHeading(line)) continue;
    const item = parseItemLine(line);
    if (item) { out.items.push(item); continue; }
    const ret = parseRetiredLine(line);
    if (ret) { out.retired.push(ret); continue; }
    out.plain.push(line);
  }
  return out;
}
