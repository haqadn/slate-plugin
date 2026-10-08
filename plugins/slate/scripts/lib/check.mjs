import { ITEM_FILES, MEMORY_FILES, RETIRED_LIKE, isHeading, parseMemoryFile, formatItem, formatRetired } from './items.mjs';

const NOW_MAX_LINES = 10;
const ITEM_FILE_NAMES = Object.values(ITEM_FILES);

// Identity of a plain line: its text after a leading "- ", else the whole line; trailing
// whitespace ignored, so an editor trimming it, or an adoption without it, loses nothing.
const plainId = line => (line.startsWith('- ') ? line.slice(2) : line).trimEnd();

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

const rawLines = text => String(text ?? '').split(/\r?\n/);

const HEADING_FILES = [...ITEM_FILE_NAMES, 'superseded.md'];

// Headings of a file; the first heading (the title) is optionally left out.
function headingsOf(text, skipTitle) {
  const hs = rawLines(text).filter(isHeading);
  return skipTitle ? hs.slice(1) : hs;
}

function bodyLines(text) {
  return rawLines(text).filter(l => l.trim() !== '' && !isHeading(l));
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
  // Only lines that are new compared with before count, so old hand-edit mess cannot freeze memory.
  const beforeMisplaced = new Set([
    ...ITEM_FILE_NAMES.flatMap(f => b[f].retired.map(formatRetired)),
    ...b['superseded.md'].items.map(formatItem),
  ]);
  for (const f of ITEM_FILE_NAMES) {
    for (const r of a[f].retired) {
      if (!beforeMisplaced.has(formatRetired(r))) v.push(`${r.id} retired line outside superseded.md`);
    }
  }
  for (const i of a['superseded.md'].items) {
    if (!beforeMisplaced.has(formatItem(i))) v.push(`${i.id} live item in superseded.md`);
  }

  // 1. Every ID live before stays live with identical text, or is properly retired.
  // Old copies are matched one by one on (ID, text), so old duplicate IDs cannot freeze a no-op.
  const livePool = new Map();
  for (const i of aLive) {
    const k = i.id + "\0" + i.text;
    livePool.set(k, (livePool.get(k) ?? 0) + 1);
  }
  for (const old of bLive) {
    const k = old.id + "\0" + old.text;
    const n = livePool.get(k) ?? 0;
    if (n > 0) { livePool.set(k, n - 1); continue; }
    if (aLive.some(i => i.id === old.id)) { v.push(`${old.id} reworded`); continue; }
    const rets = aRetired.filter(r => r.id === old.id);
    if (rets.length === 0) { v.push(`${old.id} deleted`); continue; }
    const ret = rets.find(r => r.text === old.text) ?? rets[0];
    if (ret.text !== old.text) v.push(`${old.id} reworded`);
    if (ret.retiredTurn !== turn) v.push(`${old.id} retired at t${ret.retiredTurn}, expected t${turn}`);
    if (ret.reason.trim() === "") v.push(`${old.id} retired without reason`);
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

  const idCounts = p => {
    const m = new Map();
    for (const x of [...liveItems(p), ...p['superseded.md'].retired, ...p['superseded.md'].items, ...ITEM_FILE_NAMES.flatMap(f => p[f].retired)]) {
      m.set(x.id, (m.get(x.id) ?? 0) + 1);
    }
    return m;
  };
  const seenBefore = idCounts(b);
  for (const [id, n] of idCounts(a)) if (n > 1 && n > (seenBefore.get(id) ?? 0)) v.push(`${id} duplicated`);

  const adopted = new Set();
  for (const x of [...aLive, ...aRetired]) {
    if (knownBefore.has(x.id)) continue;
    const max = maxBefore[x.type] ?? 0;
    if (x.num <= max) v.push(`${x.id} not above previous max ${x.type}${max}`);
    const isAdoption = x.turn === 0 && beforePlain.has(x.text.trimEnd());
    if (isAdoption) adopted.add(x.text.trimEnd());
    else if (x.turn !== turn) v.push(`${x.id} tagged t${x.turn}, expected t${turn}`);
    if (x.retiredTurn !== undefined) {
      if (x.retiredTurn !== turn) v.push(`${x.id} retired at t${x.retiredTurn}, expected t${turn}`);
      if (x.reason.trim() === '') v.push(`${x.id} retired without reason`);
    }
  }

  // 4. Every plain bullet from before still exists word for word, adopted or not.
  const afterPlain = new Set(ITEM_FILE_NAMES.flatMap(f => a[f].plain.map(plainId)));
  for (const id of beforePlain) {
    if (!afterPlain.has(id) && !adopted.has(id)) v.push(`plain line lost: "${id}"`);
  }

  // Headings (except each file's title) must survive, counted; they may move between files.
  const headingPool = new Map();
  for (const f of HEADING_FILES) {
    for (const h of headingsOf(after[f], false)) headingPool.set(h, (headingPool.get(h) ?? 0) + 1);
  }
  for (const f of HEADING_FILES) {
    for (const h of headingsOf(before[f], true)) {
      const n = headingPool.get(h) ?? 0;
      if (n === 0) v.push(`heading lost: "${h}"`);
      else headingPool.set(h, n - 1);
    }
  }

  // New item-looking lines that do not parse would otherwise become protected plain text.
  // New lines in item files that carry retired text would be hidden from the main thread.
  const beforeLines = new Set(HEADING_FILES.flatMap(f => rawLines(before[f])));
  for (const f of HEADING_FILES) {
    const itemFile = ITEM_FILE_NAMES.includes(f);
    for (const l of a[f].plain) {
      if ((/^- \[[IAF]/.test(l) || (itemFile && RETIRED_LIKE.test(l))) && !beforeLines.has(l)) {
        v.push(`malformed item line: "${l}"`);
      }
    }
  }
  // The same for new items; adopting a user's own bullet as it stands is always allowed.
  const beforeItems = new Set(bLive.map(i => i.id + "\0" + i.text));
  for (const i of aLive) {
    const l = formatItem(i);
    if (!RETIRED_LIKE.test(l) || beforeItems.has(i.id + "\0" + i.text)) continue;
    if (i.turn === 0 && beforePlain.has(i.text.trimEnd())) continue;
    v.push(`malformed item line: "${l}"`);
  }

  // 5. now.md is free text, at most 10 non-blank lines.
  const nowLines = rawLines(after['now.md']).filter(l => l.trim() !== '').length;
  if (nowLines > NOW_MAX_LINES) v.push(`now.md has ${nowLines} lines, max ${NOW_MAX_LINES}`);

  return [...new Set(v)];
}
