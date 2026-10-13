import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rulesText, memoryBlock, changeLine } from '../plugins/slate/scripts/lib/inject.mjs';
import {
  initSession, readSession, writeSession, nextTurn, writeMessage, appendAnswer,
} from '../plugins/slate/scripts/lib/session.mjs';

const REMINDER = 'slate: offload heavy reads to slate:offload; reply briefly.';
const COMPACT_LINE = 'Memory below wins where it differs from the summary.';
const MAX = 10000;

const temps = [];
async function session() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-inject-'));
  temps.push(root);
  return (await initSession(root, 's1', 1)).dir;
}
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});

const write = (dir, file, text) => fs.writeFile(path.join(dir, file), text);
const append = (dir, file, text) => fs.appendFile(path.join(dir, file), text);
const lines = (prefix, n, size) =>
  Array.from({ length: n }, (_, i) => `- [${prefix}${i + 1} t1] ${'x'.repeat(size)}`).join('\n');

// --- rules ---

test('rules.md carries the main-thread rules', async () => {
  const raw = await fs.readFile(new URL('../plugins/slate/rules.md', import.meta.url), 'utf8');
  for (const s of ['lead with the answer', 'offload', 'slate:offload', 'read-only', 'CLAUDE.md', 'AGENTS.md',
    '{{dir}}/instructions.md', '{{dir}}/reports/<slug>.md', 'superseded.md',
    'Return ≤10 lines', 'instead of doing it yourself', 'when unsure, offload', 'memory still updating',
    'slate warning', 'Task line', 'replaces']) {
    assert.ok(raw.includes(s), `rules.md lacks ${JSON.stringify(s)}`);
  }
  assert.ok(!raw.includes('conversation/'), 'turn files are a curator queue, not for the main thread');
  // the folder once near the top, then only the brief template's two full paths
  assert.equal(raw.split('{{dir}}').length - 1, 3);
  assert.ok(raw.indexOf('{{dir}}') < 200);
});

test('rulesText fills every {{dir}} and stays ≤1,500 chars with a 120-char path', async () => {
  const id = '0b7e8f5c-1234-4abc-9def-0123456789ab';
  const dir = `/Users/someone/${'p'.repeat(120 - '/Users/someone//.slate/'.length - id.length)}/.slate/${id}`;
  assert.equal(dir.length, 120);
  const t = await rulesText(dir);
  assert.ok(!t.includes('{{dir}}'));
  assert.ok(t.includes(`${dir}/instructions.md`));
  assert.ok(t.includes(`${dir}/reports/<slug>.md`));
  assert.ok(t.length <= 1500, `rules are ${t.length} chars`);
});

test('rulesText inserts the dir literally, even with $ patterns', async () => {
  const t = await rulesText('/tmp/$&$1/.slate/x');
  assert.ok(t.includes('/tmp/$&$1/.slate/x/instructions.md'));
});

// --- core guarantee ---

test('core: no superseded text reaches either builder', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] keep me\n- [I3 t1] ZZ-RETIRED-ZZ use npm\n');
  await memoryBlock(dir, { afterCompact: false }); // seen now holds I3's text
  await write(dir, 'instructions.md',
    '# Instructions\n- [I1 t1] keep me\n- [I4 t2] use pnpm\n' +
    // misplaced retired line and a malformed retired-looking line
    '- [I5 t1 retired t2] ZZ-RETIRED-ZZ misplaced (reason: moved)\n' +
    '- [I6 t1 retired t2] ZZ-RETIRED-ZZ no reason\n');
  await write(dir, 'superseded.md',
    '# Superseded\n- [I3 t1 retired t2] ZZ-RETIRED-ZZ use npm (reason: user switched to pnpm)\n' +
    'ZZ-RETIRED-ZZ stray plain line\n');

  // a curator.log warning quoting a superseded.md line
  await write(dir, 'curator.log',
    '2026-10-07T10:00:00.000Z t2 restored: superseded.md lost line: "- [I3 t1 retired t2] ZZ-RETIRED-ZZ use npm (reason: x)"; I9 deleted\n');

  const line = await changeLine(dir, { waiting: false });
  assert.ok(!line.includes('ZZ-RETIRED-ZZ'), line);
  assert.ok(line.includes('retired I3'), line);
  assert.ok(line.includes(`slate warning: t2 restored: superseded line lost, I9 deleted (see ${path.join(dir, 'curator.log')})`), line);

  for (const afterCompact of [false, true]) {
    const block = await memoryBlock(dir, { afterCompact });
    assert.ok(!block.includes('ZZ-RETIRED-ZZ'), block);
    assert.ok(block.includes('- [I4 t2] use pnpm'));
  }
  // also when facts spill and the block is cut
  await write(dir, 'facts.md', `# Facts\n${lines('F', 30, 1000)}\n`);
  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 30, 1000)}\n`);
  const cut = await memoryBlock(dir, { afterCompact: true });
  assert.ok(!cut.includes('ZZ-RETIRED-ZZ'));
  assert.ok(!(await changeLine(dir, { waiting: true })).includes('ZZ-RETIRED-ZZ'));
});

const RETIRED_SHAPES = [
  '* [I7 t1 retired t2] ZZ-RETIRED-ZZ star bullet (reason: r)',
  '> - [I8 t1 retired t2] ZZ-RETIRED-ZZ quoted (reason: r)',
  '- [I6 retired t2] ZZ-RETIRED-ZZ no turn',
  '- [I9 t1 Retired t2] ZZ-RETIRED-ZZ capitalised (reason: r)',
  'note [A2 t1 RETIRED t3] ZZ-RETIRED-ZZ mid-line',
  // exact copies of retired I3 "ZZ-RETIRED-ZZ use npm" under bullets, quotes, checkboxes, emphasis, case
  '- ZZ-RETIRED-ZZ use npm',
  '> * [ ] ~~ZZ-RETIRED-ZZ   use NPM~~ (reason: old)',
  '1. **ZZ-RETIRED-ZZ use npm**',
  '+ `zz-retired-zz use npm`',
  '_ZZ-Retired-ZZ use npm_',
  '2) [x] *ZZ-RETIRED-ZZ use npm*',
  // free-form retired notes that name an ID
  '- ~~ZZ-RETIRED-ZZ use yarn~~ (retired I1)',
  'ZZ-RETIRED-ZZ old deploy rule, RETIRED F12 at t4',
  '- ZZ-RETIRED-ZZ tabs (retired  a3)',
];

test('core: retired-looking lines and copies of retired text stay out of the block', async () => {
  const dir = await session();
  await write(dir, 'superseded.md', '# Superseded\n- [I3 t1 retired t2] ZZ-RETIRED-ZZ use npm (reason: pnpm now)\n');
  await write(dir, 'instructions.md', `# Instructions\n- [I4 t2] use pnpm\n- live hand edit\n${RETIRED_SHAPES.join('\n')}\n`);
  await write(dir, 'now.md', `Goal: ship\n${RETIRED_SHAPES.join('\n')}\nNext: tests\n`);
  const b = await memoryBlock(dir, { afterCompact: false });
  assert.ok(!/zz-retired-zz/i.test(b), b);
  for (const s of ['- [I4 t2] use pnpm', '- live hand edit', 'Goal: ship', 'Next: tests']) assert.ok(b.includes(s), s);
});

test('live lines that merely mention a retired text stay in the block', async () => {
  const dir = await session();
  await write(dir, 'superseded.md',
    '# Superseded\n- [I3 t1 retired t2] use npm (reason: pnpm now)\n- [A1 t1 retired t2] a (reason: one letter)\n');
  await write(dir, 'instructions.md', '# Instructions\n- never use npm in CI\n- use npm\n');
  await write(dir, 'now.md', 'Goal: ship v2\nNext: replace every use npm call in scripts/\n- a\n');
  const b = await memoryBlock(dir, { afterCompact: false });
  for (const s of ['- never use npm in CI', 'Next: replace every use npm call in scripts/', 'Goal: ship v2']) {
    assert.ok(b.includes(s), s);
  }
  assert.ok(!b.split('\n').includes('- use npm'), 'exact copy dropped');
  assert.ok(!b.split('\n').includes('- a'), 'exact copy of a one-letter retired item dropped');
});

test('lines that say "retired" without naming an ID stay in the block', async () => {
  const dir = await session();
  const keep = ['- the retired server stays off', '- retired I2C bus driver', '- retire I3 next week'];
  await write(dir, 'instructions.md', `# Instructions\n${keep.join('\n')}\n`);
  await write(dir, 'now.md', 'Focus: retired hosts list\n');
  const b = await memoryBlock(dir, { afterCompact: false });
  for (const s of [...keep, 'Focus: retired hosts list']) assert.ok(b.includes(s), s);
});

test('core: an item whose text carries a retired tag is shown by ID only', async () => {
  const dir = await session();
  await write(dir, 'instructions.md',
    '# Instructions\n- [I1 t1] fine\n- [I5 t2] [I3 t1 retired t2] ZZ-RETIRED-ZZ x\n- [I6 t2] ZZ-RETIRED-ZZ yarn (retired I2)\n');
  const line = await changeLine(dir, { waiting: false });
  assert.ok(!line.includes('ZZ-RETIRED-ZZ'), line);
  assert.ok(line.includes('+I1 fine') && line.includes(`+2 more (see ${path.join(dir, 'instructions.md')})`), line);
  assert.ok(!(await memoryBlock(dir, { afterCompact: false })).includes('ZZ-RETIRED-ZZ'));
});

test('core: warnings echo only status, IDs and violation kinds, never log text', async () => {
  const dir = await session();
  const log = path.join(dir, 'curator.log');
  await write(dir, 'curator.log', [
    't1 restored: superseded.md lost line: "- [I3 t1 retired t2] ZZ-RETIRED-ZZ unbalanced',
    't2 restored: I4 reworded from ZZ-RETIRED-ZZ use npm to use pnpm',
    "t3 restored: plain line lost: 'ZZ-RETIRED-ZZ single'",
    't4 restored: heading lost: \u201cZZ-RETIRED-ZZ curly\u201d; F2 duplicated',
    't5 error: ZZ-RETIRED-ZZ claude exited 1',
  ].map((l) => `2026-10-07T10:00:00.000Z ${l}\n`).join(''));
  const out = await changeLine(dir, { waiting: false });
  assert.ok(!out.includes('ZZ-RETIRED-ZZ'), out);
  for (const w of [
    't1 restored: superseded line lost',
    't2 restored: I4 reworded',
    't3 restored: plain line lost',
    't4 restored: heading lost, F2 duplicated',
    't5 error',
  ]) assert.ok(out.split('\n').includes(`slate warning: ${w} (see ${log})`), `${w}\n${out}`);

  // IDs and kinds inside quotes are never picked up
  await append(dir, 'curator.log', '2026-10-07T10:00:00.000Z t6 restored: plain line lost: "print on A4 paper, F1 style"; ' +
    'heading lost: "deleted and I7 reworded"; I2 duplicated\n');
  assert.equal(await changeLine(dir, { waiting: false }),
    `${REMINDER}\nslate warning: t6 restored: plain line lost, heading lost, I2 duplicated (see ${log})`);
});

// --- memoryBlock ---

test('memoryBlock: heading, rules, then instructions, now, facts, assumptions with IDs', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use pnpm\n- plain user bullet\n');
  await write(dir, 'now.md', '## Goal\nGoal: ship slate\nNext: write tests\n');
  await write(dir, 'facts.md', '# Facts\n- [F1 t2] tests use node:test (package.json)\n');
  await write(dir, 'assumptions.md', '# Assumptions\n- [A1 t2] user is on macOS\n');
  const b = await memoryBlock(dir, { afterCompact: false });
  const rules = await rulesText(dir);
  const at = (s) => {
    const i = b.indexOf(s);
    assert.ok(i >= 0, `missing ${s}`);
    return i;
  };
  assert.ok(b.startsWith('#'), 'starts with a heading');
  assert.ok(!b.includes(COMPACT_LINE));
  const order = [rules.trim(), '- [I1 t1] Use pnpm', 'Goal: ship slate', '- [F1 t2] tests use node:test (package.json)',
    '- [A1 t2] user is on macOS'].map(at);
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  at('- plain user bullet');
  assert.ok(at('## Goal') < at('Goal: ship slate'), 'now.md kept verbatim, headings included');
  assert.ok(b.length <= MAX);
});

test('memoryBlock: afterCompact adds the "wins over the summary" line', async () => {
  const dir = await session();
  const b = await memoryBlock(dir, { afterCompact: true });
  assert.ok(b.includes(COMPACT_LINE));
  assert.ok(b.indexOf(COMPACT_LINE) < b.indexOf((await rulesText(dir)).trim()));
});

test('memoryBlock: 30k chars of facts stay under 10,000 and point at facts.md', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use pnpm\n');
  await write(dir, 'assumptions.md', '# Assumptions\n- [A1 t1] small guess\n');
  await write(dir, 'facts.md', `# Facts\n${lines('F', 30, 1000)}\n`);
  const b = await memoryBlock(dir, { afterCompact: false });
  assert.ok(b.length <= MAX, `${b.length}`);
  assert.ok(b.includes(path.join(dir, 'facts.md')));
  assert.ok(!b.includes('x'.repeat(1000)));
  assert.ok(b.includes('- [I1 t1] Use pnpm'));
  assert.ok(b.includes('- [A1 t1] small guess'), 'assumptions kept when facts alone suffice');
});

test('memoryBlock: facts then assumptions spill, then instructions are cut with a pointer', async () => {
  const dir = await session();
  await write(dir, 'facts.md', `# Facts\n${lines('F', 10, 1000)}\n`);
  await write(dir, 'assumptions.md', `# Assumptions\n${lines('A', 10, 1000)}\n`);
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use pnpm\n');
  let b = await memoryBlock(dir, { afterCompact: false });
  assert.ok(b.length <= MAX);
  assert.ok(b.includes(path.join(dir, 'facts.md')) && b.includes(path.join(dir, 'assumptions.md')));

  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 30, 1000)}\n`);
  b = await memoryBlock(dir, { afterCompact: true });
  assert.ok(b.length <= MAX, `${b.length}`);
  assert.ok(b.includes('- [I1 t1] '), 'first instructions kept');
  assert.ok(b.includes(`more; read ${path.join(dir, 'instructions.md')}`));
  assert.ok(b.includes(COMPACT_LINE));
});

test('memoryBlock: now.md is cut before instructions', async () => {
  const dir = await session();
  // instructions fit alone, not together with now
  const n = Math.floor((MAX - (await rulesText(dir)).length - 200) / 1012);
  await write(dir, 'now.md', `${'n'.repeat(100)}\n`.repeat(15));
  await write(dir, 'instructions.md', `# Instructions\n${lines('I', n, 1000)}\n`);
  const b = await memoryBlock(dir, { afterCompact: false });
  assert.ok(b.length <= MAX, `${b.length}`);
  for (let i = 1; i <= n; i++) assert.ok(b.includes(`- [I${i} t1] `), `I${i} kept in full`);
  assert.ok(b.includes(`more; read ${path.join(dir, 'now.md')}`), 'now.md cut with a pointer');
  assert.ok(!b.includes(`more; read ${path.join(dir, 'instructions.md')}`), 'instructions not cut');
});

test('memoryBlock: never exceeds 10,000 even with a huge now.md', async () => {
  const dir = await session();
  await write(dir, 'now.md', `${'y'.repeat(200)}\n`.repeat(100));
  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 30, 1000)}\n`);
  const b = await memoryBlock(dir, { afterCompact: true });
  assert.ok(b.length <= MAX, `${b.length}`);
  assert.ok(b.includes(COMPACT_LINE));
});

test('memoryBlock sets seen to the live items it covers, spilled ones included', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use pnpm\n');
  await write(dir, 'facts.md', `# Facts\n${lines('F', 30, 1000)}\n`);
  await memoryBlock(dir, { afterCompact: false });
  const { seen } = await readSession(dir);
  assert.equal(seen.I1, 'Use pnpm');
  assert.equal(Object.keys(seen).length, 31);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);
});

// --- changeLine ---

test('changeLine: add shows full text, retire shows the ID only, no change shows only the reminder', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use npm for installs\n');
  await memoryBlock(dir, { afterCompact: false });

  await append(dir, 'instructions.md', '- [I2 t2] Always run the linter before committing\n');
  let line = await changeLine(dir, { waiting: false });
  assert.ok(line.startsWith(REMINDER), line);
  assert.ok(line.includes('+I2 Always run the linter before committing'), line);

  await write(dir, 'instructions.md', '# Instructions\n- [I2 t2] Always run the linter before committing\n');
  await append(dir, 'superseded.md', '- [I1 t1 retired t3] Use npm for installs (reason: pnpm now)\n');
  line = await changeLine(dir, { waiting: false });
  assert.ok(line.includes('retired I1'), line);
  assert.ok(!line.includes('Use npm'), line);

  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);
});

test('changeLine: an item moved to another file is not a change', async () => {
  const dir = await session();
  await write(dir, 'assumptions.md', '# Assumptions\n- [A1 t1] user is on macOS\n');
  await memoryBlock(dir, { afterCompact: false });
  await write(dir, 'assumptions.md', '# Assumptions\n');
  await write(dir, 'facts.md', '# Facts\n- [A1 t1] user is on macOS\n');
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);
});

test('changeLine: a hand edit to a known ID shows the new text under that ID', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use npm\n');
  await memoryBlock(dir, { afterCompact: false });
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use pnpm\n');
  assert.equal(await changeLine(dir, { waiting: false }), `${REMINDER}\nslate: +I1 Use pnpm`);
});

test('changeLine: exact format', async () => {
  const dir = await session();
  const s = await readSession(dir);
  s.seen = { I3: 'Use npm' };
  await writeSession(dir, s);
  await write(dir, 'instructions.md', '# Instructions\n- [I14 t5] Use pnpm\n');
  await write(dir, 'facts.md', '# Facts\n- [F2 t5] tests use vitest (package.json)\n');
  assert.equal(await changeLine(dir, { waiting: false }),
    `${REMINDER}\nslate: +I14 Use pnpm · retired I3 · +F2 tests use vitest (package.json)`);
});

test('changeLine: at most 5 adds in full, the rest as +N more with a path', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', `# Instructions\n${Array.from({ length: 6 }, (_, i) => `- [I${i + 1} t1] rule ${i + 1}`).join('\n')}\n`);
  await write(dir, 'facts.md', '# Facts\n- [F1 t1] fact one (src)\n');
  const line = await changeLine(dir, { waiting: false });
  for (let i = 1; i <= 5; i++) assert.ok(line.includes(`+I${i} rule ${i}`), line);
  assert.ok(!line.includes('rule 6') && !line.includes('fact one'), line);
  assert.ok(line.includes(`+2 more (see ${path.join(dir, 'instructions.md')}, facts.md)`), line);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER, 'hidden adds count as seen');
});

test('changeLine: waiting says memory is still updating and defers the diff', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', '# Instructions\n- [I1 t1] Use pnpm\n');
  const w = await changeLine(dir, { waiting: true });
  assert.equal(w, `${REMINDER}\nslate: memory still updating`);
  assert.deepEqual((await readSession(dir)).seen, {});
  assert.equal(await changeLine(dir, { waiting: false }), `${REMINDER}\nslate: +I1 Use pnpm`);
});

test('changeLine: curator.log restored/error lines show once, other statuses never', async () => {
  const dir = await session();
  await write(dir, 'curator.log',
    '2026-10-07T10:00:00.000Z t1 ok: kept\n' +
    '2026-10-07T10:01:00.000Z t2 restored: I3 deleted\n' +
    '2026-10-07T10:02:00.000Z t3 error: claude exited 1\n');
  const first = await changeLine(dir, { waiting: false });
  const log = path.join(dir, 'curator.log');
  assert.ok(first.includes(`slate warning: t2 restored: I3 deleted (see ${log})`), first);
  assert.ok(first.includes(`slate warning: t3 error (see ${log})`), first);
  assert.ok(!first.includes('kept') && !first.includes('exited'), first);
  assert.ok(!first.includes('2026-10-07T'), 'timestamps dropped');
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);

  // logSeen survives other session.json writers
  await nextTurn(dir);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);

  // a partial line waits until it is complete
  await append(dir, 'curator.log', '2026-10-07T10:03:00.000Z t4 rest');
  assert.equal(await changeLine(dir, { waiting: true }), `${REMINDER}\nslate: memory still updating`);
  await append(dir, 'curator.log', 'ored: F1 reworded\n');
  const later = await changeLine(dir, { waiting: false });
  assert.ok(later.includes(`slate warning: t4 restored: F1 reworded (see ${log})`), later);
  assert.ok(!later.includes('t2 restored'), later);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);
});

test('changeLine: a log replaced by a shorter one is read from the start', async () => {
  const dir = await session();
  await write(dir, 'curator.log', `${'2026-10-07T10:00:00.000Z t1 ok: fine\n'.repeat(5)}`);
  await changeLine(dir, { waiting: false });
  await write(dir, 'curator.log', '2026-10-07T11:00:00.000Z t9 error: boom\n');
  assert.ok((await changeLine(dir, { waiting: false })).includes('slate warning: t9 error (see'));
});

test('changeLine stays within the hook cap with huge items and many warnings', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 5, 3000)}\n`);
  await write(dir, 'curator.log', `${'2026-10-07T10:00:00.000Z t1 error: ' + 'e'.repeat(5000) + '\n'}`.repeat(50));
  const line = await changeLine(dir, { waiting: false });
  assert.ok(line.length <= MAX, `${line.length}`);
  assert.ok(line.startsWith(REMINDER));
});

// --- memoryBlock: curation behind ---

// Turns 1..n recorded and answered; curated.json says `done` (null: no curated.json).
async function turns(n, done) {
  const dir = await session();
  for (let t = 1; t <= n; t++) {
    await nextTurn(dir, { lastKind: 'user' });
    await writeMessage(dir, t, `message ${t}`);
    await appendAnswer(dir, t, `answer ${t}`);
  }
  if (done) await write(dir, 'curated.json', `${JSON.stringify(done)}\n`);
  return dir;
}
const size = async (dir, t) => (await fs.stat(path.join(dir, 'queue', `000${t}.md`))).size;
const lag = (dir, t) =>
  `slate: memory may not include turn ${t} yet — read ${path.join(dir, 'queue', `000${t}.md`)} before acting on recent instructions.`;

test('Important 2: memoryBlock notes the turn curation has not reached, right under the heading', async () => {
  const dir = await turns(3, null);
  await write(dir, 'curated.json', `${JSON.stringify({ turn: 2, size: await size(dir, 2) })}\n`);
  const b = await memoryBlock(dir, { afterCompact: true });
  assert.ok(b.startsWith(`# slate memory\n${COMPACT_LINE}\n${lag(dir, 3)}\n`), b.slice(0, 400));
  assert.ok(b.length <= MAX);
});

test('Important 2: several turns behind names the range; no curated.json counts as none curated', async () => {
  const dir = await turns(3, null);
  const b = await memoryBlock(dir, { afterCompact: false });
  const conv = path.join(dir, 'queue');
  assert.ok(b.includes(`slate: memory may not include turns 1–3 yet — read ${conv}/0001.md to 0003.md before acting on recent instructions.`), b.slice(0, 400));
});

test('Important 2: a continuation not yet curated reopens its turn', async () => {
  const dir = await turns(2, null);
  await write(dir, 'curated.json', `${JSON.stringify({ turn: 2, size: await size(dir, 2) })}\n`);
  assert.ok(!(await memoryBlock(dir)).includes('may not include'), 'caught up');
  await appendAnswer(dir, 2, 'the background agent finished');
  assert.ok((await memoryBlock(dir)).includes(lag(dir, 2)));
});

test('Important 2: caught up, or no turns yet: no note', async () => {
  const fresh = await session();
  assert.ok(!(await memoryBlock(fresh)).includes('slate: memory'));
  const dir = await turns(2, null);
  await write(dir, 'curated.json', `${JSON.stringify({ turn: 2, size: await size(dir, 2) })}\n`);
  assert.ok(!(await memoryBlock(dir)).includes('slate: memory'));
});

test('M2: waiting says memory is still updating, with the turn it may lack', async () => {
  const dir = await turns(1, { turn: 0, size: 0 });
  const b = await memoryBlock(dir, { waiting: true });
  const file = path.join(dir, 'queue', '0001.md');
  assert.ok(b.startsWith(`# slate memory\nslate: memory still updating; it may not include turn 1 yet — read ${file} before acting on recent instructions.\n`), b.slice(0, 400));
  const fresh = await session();
  assert.ok((await memoryBlock(fresh, { waiting: true })).startsWith('# slate memory\nslate: memory still updating.\n'));
});

test('Important 2: the note survives a block cut to 10,000 chars', async () => {
  const dir = await turns(1, null);
  await write(dir, 'now.md', `${'y'.repeat(200)}\n`.repeat(100));
  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 30, 1000)}\n`);
  const b = await memoryBlock(dir, { afterCompact: true, waiting: true });
  assert.ok(b.length <= MAX, `${b.length}`);
  assert.ok(b.includes('slate: memory still updating; it may not include turn 1 yet'));
});
