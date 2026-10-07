import { ITEM_FILES, MEMORY_FILES, isHeading, parseMemoryFile } from './items.mjs';

const NOW_MAX_LINES = 10;
const ITEM_FILE_NAMES = Object.values(ITEM_FILES);

// Identity of a plain line: its text after a leading "- ", else the whole line.
const plainId = line => (line.startsWith('- ') ? line.slice(2) : line);

function parseAll(files, label, violations) {
  const parsed = {};
  for (const f of MEMORY_FILES) {
    if (typeof files[f] !== 'string') {
      if (label === 'after') violations.push(`${f} missing`);
      parsed[f] = parseMemoryFile('');
    } else {
      parsed[f] = parseMemoryFile(files[f]);
    }
  }
  return parsed;
}

function liveItems(p) {
  return ITEM_FILE_NAMES.flatMap(f => p[f].items);
}

function bodyLines(text) {
  return String(text ?? '').split('\n').filter(l => l.trim() !== '' && !isHeading(l));
}

// Returns a list of violations; an empty list means the curator's edit is safe to keep.
export function checkCuratorEdit(before, after, turn) {
  const v = [];
  const b = parseAll(before, 'before', v);
  const a = parseAll(after, 'after', v);

  const bLive = liveItems(b);
  const bRetired = b['superseded.md'].retired;
  const aLive = liveItems(a);
  const aRetired = a['superseded.md'].retired;

  // Placement problems: parse is fine, but the line is in the wrong kind of file.
  for (const f of ITEM_FILE_NAMES) {
    for (const r of a[f].retired) v.push(`${r.id} retired line outside superseded.md`);
  }
  for (const i of a['superseded.md'].items) v.push(`${i.id} live item in superseded.md`);

  // 1. Every ID live before stays live with identical text, or is properly retired.
  const aLiveById = new Map();
  for (const i of aLive) if (!aLiveById.has(i.id)) aLiveById.set(i.id, i);
  const aRetiredById = new Map();
  for (const r of aRetired) if (!aRetiredById.has(r.id)) aRetiredById.set(r.id, r);
  for (const old of bLive) {
    const live = aLiveById.get(old.id);
    if (live) {
      if (live.text !== old.text) v.push(`${old.id} reworded`);
      continue;
    }
    const ret = aRetiredById.get(old.id);
    if (!ret) { v.push(`${old.id} deleted`); continue; }
    if (ret.text !== old.text) v.push(`${old.id} reworded`);
    if (ret.retiredTurn !== turn) v.push(`${old.id} retired at t${ret.retiredTurn}, expected t${turn}`);
    if (ret.reason.trim() === '') v.push(`${old.id} retired without reason`);
  }

  // 2. superseded.md only gained lines.
  const counts = new Map();
  for (const l of bodyLines(after['superseded.md'])) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const l of bodyLines(before['superseded.md'])) {
    const n = counts.get(l) ?? 0;
    if (n === 0) v.push(`superseded.md lost line: "${l}"`);
    else counts.set(l, n - 1);
  }

  // 3. New IDs are unique, above the previous per-type maximum, and tagged with this turn.
  //    Adopting a plain bullet (t0, identical text) is the one exception to the turn tag.
  const beforePlain = new Set(ITEM_FILE_NAMES.flatMap(f => b[f].plain.map(plainId)));
  const knownBefore = new Set([...bLive, ...bRetired].map(x => x.id));
  const maxBefore = {};
  for (const x of [...bLive, ...bRetired]) maxBefore[x.type] = Math.max(maxBefore[x.type] ?? 0, x.num);

  const seen = new Map();
  for (const x of [...aLive, ...aRetired, ...a['superseded.md'].items, ...ITEM_FILE_NAMES.flatMap(f => a[f].retired)]) {
    seen.set(x.id, (seen.get(x.id) ?? 0) + 1);
  }
  for (const [id, n] of seen) if (n > 1) v.push(`${id} duplicated`);

  const adopted = new Set();
  for (const x of [...aLive, ...aRetired]) {
    if (knownBefore.has(x.id)) continue;
    const max = maxBefore[x.type] ?? 0;
    if (x.num <= max) v.push(`${x.id} not above previous max ${x.type}${max}`);
    const isAdoption = x.turn === 0 && !x.retiredTurn && beforePlain.has(x.text);
    if (isAdoption) adopted.add(x.text);
    else if (x.turn !== turn) v.push(`${x.id} tagged t${x.turn}, expected t${turn}`);
  }

  // 4. Every plain bullet from before still exists word for word, adopted or not.
  const afterPlain = new Set(ITEM_FILE_NAMES.flatMap(f => a[f].plain.map(plainId)));
  for (const id of beforePlain) {
    if (!afterPlain.has(id) && !adopted.has(id)) v.push(`plain line lost: "${id}"`);
  }

  // 5. now.md is free text, at most 10 non-blank lines.
  const nowLines = String(after['now.md'] ?? '').split('\n').filter(l => l.trim() !== '').length;
  if (nowLines > NOW_MAX_LINES) v.push(`now.md has ${nowLines} lines, max ${NOW_MAX_LINES}`);

  return [...new Set(v)];
}
