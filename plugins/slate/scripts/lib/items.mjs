export const ITEM_FILES = { I: 'instructions.md', A: 'assumptions.md', F: 'facts.md' };
export const MEMORY_FILES = ['instructions.md', 'assumptions.md', 'facts.md', 'now.md', 'superseded.md'];

const HEADING = /^#{1,6}(\s|$)/;
// A line that carries retired text: a retired-style tag, however mangled, or a free-form note
// naming a retired ID ("~~use npm~~ (retired I1)"). Never injected; the apply step refuses new ones.
export const RETIRED_LIKE = /\[[IAF]\d+\b[^\]]*\bretired\b|\bretired\s+[IAF]\d+\b/i;
// Origin tag `t<turn>@<session8>`: the session's turn and the first 8 chars of its ID. Older
// tags have no `@…` part, and an adopted plain bullet is `t0`.
const ORIGIN = 't(\\d+)(?:@([A-Za-z0-9._-]{1,8}))?';
const ITEM = new RegExp(`^- \\[([IAF])(\\d+) ${ORIGIN}\\] (.*)$`);
const RETIRED = new RegExp(`^- \\[([IAF])(\\d+) ${ORIGIN} retired ${ORIGIN}\\] (.*) \\(reason: (.*)\\)$`);

const origin = (turn, session) => `t${turn}${session ? `@${session}` : ''}`;

export function isHeading(line) {
  return HEADING.test(line);
}

export function parseItemLine(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  return {
    id: m[1] + Number(m[2]), type: m[1], num: Number(m[2]), turn: Number(m[3]), session: m[4] ?? null, text: m[5],
  };
}

export function formatItem({ id, turn, session, text }) {
  return `- [${id} ${origin(turn, session)}] ${text}`;
}

export function parseRetiredLine(line) {
  const m = RETIRED.exec(line);
  if (!m) return null;
  return {
    id: m[1] + Number(m[2]), type: m[1], num: Number(m[2]), turn: Number(m[3]), session: m[4] ?? null,
    retiredTurn: Number(m[5]), retiredSession: m[6] ?? null, text: m[7], reason: m[8],
  };
}

export function formatRetired(r) {
  const tag = `${r.id} ${origin(r.turn, r.session)} retired ${origin(r.retiredTurn, r.retiredSession)}`;
  return `- [${tag}] ${r.text} (reason: ${r.reason})`;
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
