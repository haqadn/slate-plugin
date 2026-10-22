import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rulesText, memoryBlock, changeLine } from '../plugins/slate/scripts/lib/inject.mjs';
import { memoryPath, slateOf } from '../plugins/slate/scripts/lib/slate.mjs';
import { MEMORY_FILES } from '../plugins/slate/scripts/lib/items.mjs';
import { initSession } from './helpers.mjs';
import {
  readSession, writeSession, nextTurn, writeMessage, appendAnswer,
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

const fileOf = (dir, file) => (MEMORY_FILES.includes(file) ? memoryPath(dir, file) : path.join(dir, file));
const write = (dir, file, text) => fs.writeFile(fileOf(dir, file), text);
const append = (dir, file, text) => fs.appendFile(fileOf(dir, file), text);
const lines = (prefix, n, size) =>
  Array.from({ length: n }, (_, i) => `- [${prefix}${i + 1} t1] ${'x'.repeat(size)}`).join('\n');
const topicPath = (dir, slug) => path.join(slateOf(dir), 'topics', `${slug}.md`);
async function writeTopic(dir, slug, text) {
  await fs.mkdir(path.join(slateOf(dir), 'topics'), { recursive: true });
  await fs.writeFile(topicPath(dir, slug), text);
}

// --- rules ---

test('rules.md carries the main-thread rules', async () => {
  const raw = await fs.readFile(new URL('../plugins/slate/rules.md', import.meta.url), 'utf8');
  for (const s of ['lead with the answer', 'offload', 'slate:offload', 'read-only', 'CLAUDE.md', 'AGENTS.md',
    '{{slate}}/instructions.md', '{{session}}/now.md', '{{slate}}/reports/<slug>.md', 'a slug no other report uses',
    'Slate-folder files: superseded.md', 'Go longer when the task needs it.',
    'Keep conversation, decisions, small targeted reads here.', 'Return ≤10 lines', 'instead of doing it yourself', 'when unsure, offload',
    'memory still updating', 'slate warning', 'Task line', 'replaces', 'offloads.md', 'transcript path',
    'topic files', '`# Topics`', 'read the ones the task needs', '`+2 in x`']) {
    assert.ok(raw.includes(s), `rules.md lacks ${JSON.stringify(s)}`);
  }
  // Recent Claude Code has no Grep or Glob tool, and Bash on slate paths is denied in the default
  // permission mode (live acceptance, 2.1.308): reports are found through offloads.md and read with Read.
  assert.match(raw, /offloads\.md[^\n]*report and transcript paths/, 'offloads.md is how a session finds a report');
  assert.match(raw, /read-only for you[^\n]*Bash there is denied/, 'slate files are read with Read, never Bash');
  assert.match(raw, /Agent brief: "Read [^\n]*topic files[^\n]*Task:/, 'a brief names the topic files the task needs');
  assert.ok(!raw.includes('{{dir}}'));
  assert.ok(!raw.includes('conversation/'), 'turn files are a curator queue, not for the main thread');
  assert.ok(raw.indexOf('{{slate}}') < 50 && raw.indexOf('{{session}}') < 100, 'both folders named at the top');
});

test('rulesText fills every placeholder and stays ≤1,900 chars with a 120-char session path', async () => {
  const id = '0b7e8f5c-1234-4abc-9def-0123456789ab';
  const tail = `/.sessions/${id}`;
  const slate = `/Users/someone/${'p'.repeat(120 - '/Users/someone/'.length - tail.length)}`;
  const dir = slate + tail;
  assert.equal(dir.length, 120);
  const t = await rulesText(dir);
  assert.ok(!t.includes('{{'));
  assert.ok(t.includes(`Slate (shared with other sessions): ${slate}. Session: ${dir}.`));
  assert.ok(t.includes(`${slate}/instructions.md`));
  assert.ok(t.includes(`${dir}/now.md`));
  assert.ok(t.includes(`${slate}/reports/<slug>.md`));
  assert.ok(t.length <= 1900, `rules are ${t.length} chars`);
});

test('rulesText inserts the paths literally, even with $ patterns', async () => {
  const t = await rulesText('/tmp/$&$1/x/.sessions/$`s');
  assert.ok(t.includes('/tmp/$&$1/x/instructions.md'));
  assert.ok(t.includes('/tmp/$&$1/x/.sessions/$`s/now.md'));
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

  // curator.log warnings: one quoting a superseded.md line in its error text
  await write(dir, 'curator.log',
    '2026-10-07T10:00:00.000Z t2 error: exit 1: "- [I3 t1 retired t2] ZZ-RETIRED-ZZ use npm (reason: x)"\n' +
    '2026-10-07T10:00:01.000Z t3 partial: 0:stale I9; 1:no source; applied 2:add I4\n');

  const line = await changeLine(dir, { waiting: false });
  assert.ok(!line.includes('ZZ-RETIRED-ZZ'), line);
  assert.ok(line.includes('retired I3'), line);
  const log = path.join(dir, 'curator.log');
  assert.ok(line.includes(`slate warning: t2 error (see ${log})`), line);
  assert.ok(line.includes(`slate warning: t3 partial: stale I9, no source (see ${log})`), line);

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
  assert.ok(line.includes('+I1 fine') && line.includes(`+2 more (see ${memoryPath(dir, 'instructions.md')})`), line);
  assert.ok(!(await memoryBlock(dir, { afterCompact: false })).includes('ZZ-RETIRED-ZZ'));
});

test('core: warnings echo only status, IDs and error kinds, never log text', async () => {
  const dir = await session();
  const log = path.join(dir, 'curator.log');
  await write(dir, 'curator.log', [
    't1 partial: 0:stale I3; 1:bad id; 2:empty text; applied 3:add I4',
    't2 partial: 0:multi-line text; 1:tag in text; 2:no source; 3:report source',
    't3 partial: 0:empty reason; 1:multi-line reason; 2:now too long; 3:tag in now; 4:bad op',
    't4 error: exit 1: "- [I3 t1 retired t2] ZZ-RETIRED-ZZ unbalanced',
    't5 error: ZZ-RETIRED-ZZ claude exited 1',
  ].map((l) => `2026-10-07T10:00:00.000Z ${l}\n`).join(''));
  const out = await changeLine(dir, { waiting: false });
  assert.ok(!out.includes('ZZ-RETIRED-ZZ'), out);
  for (const w of [
    't1 partial: stale I3, bad id, empty text',
    't2 partial: multi-line text, tag in text, no source, report source',
    't3 partial: empty reason, multi-line reason, now too long, tag in now, bad op',
    't4 error',
    't5 error',
  ]) assert.ok(out.split('\n').includes(`slate warning: ${w} (see ${log})`), `${w}\n${out}`);

  // the kinds of topic, home and move errors
  await append(dir, 'curator.log', [
    't7 partial: 0:bad slug; 1:empty title; 2:empty summary; 3:multi-line title; 4:multi-line summary',
    't8 partial: 0:missing topic; 1:no home; 2:instruction move; 3:stale F4; applied 4:move F2>key; demoted F1>x',
  ].map((l) => `2026-10-07T10:00:00.000Z ${l}\n`).join(''));
  assert.equal(await changeLine(dir, { waiting: false }), [REMINDER,
    `slate warning: t7 partial: bad slug, empty title, empty summary, multi-line title, multi-line summary (see ${log})`,
    `slate warning: t8 partial: missing topic, no home, instruction move, stale F4 (see ${log})`].join('\n'));

  // IDs and kinds inside quotes are never picked up
  await append(dir, 'curator.log', '2026-10-07T10:00:00.000Z t6 error: exit 1: "0:stale I7 and 1:no source"; 2:stale I2\n');
  assert.equal(await changeLine(dir, { waiting: false }),
    `${REMINDER}\nslate warning: t6 error: stale I2 (see ${log})`);
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
  assert.ok(b.includes(memoryPath(dir, 'facts.md')));
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
  assert.ok(b.includes(memoryPath(dir, 'facts.md')) && b.includes(memoryPath(dir, 'assumptions.md')));

  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 30, 1000)}\n`);
  b = await memoryBlock(dir, { afterCompact: true });
  assert.ok(b.length <= MAX, `${b.length}`);
  assert.ok(b.includes('- [I1 t1] '), 'first instructions kept');
  assert.ok(b.includes(`more; read ${memoryPath(dir, 'instructions.md')}`));
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
  assert.ok(b.includes(`more; read ${memoryPath(dir, 'now.md')}`), 'now.md cut with a pointer');
  assert.ok(!b.includes(`more; read ${memoryPath(dir, 'instructions.md')}`), 'instructions not cut');
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
  assert.ok(line.includes(`+2 more (see ${memoryPath(dir, 'instructions.md')}, ${memoryPath(dir, 'facts.md')})`), line);
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

test('changeLine: curator.log partial/error lines show once, other statuses never', async () => {
  const dir = await session();
  await write(dir, 'curator.log',
    '2026-10-07T10:00:00.000Z t1 ok: attempt 1: applied 0:add I1\n' +
    '2026-10-07T10:01:00.000Z t2 retry: 0:stale I3\n' +
    '2026-10-07T10:01:01.000Z t2 partial: 0:stale I3; applied nothing\n' +
    '2026-10-07T10:01:30.000Z t2 restored: I5 deleted\n' +
    '2026-10-07T10:01:40.000Z t2 aborted: requeued\n' +
    '2026-10-07T10:02:00.000Z t3 error: claude exited 1\n');
  const first = await changeLine(dir, { waiting: false });
  const log = path.join(dir, 'curator.log');
  assert.equal(first, [
    REMINDER,
    `slate warning: t2 partial: stale I3 (see ${log})`,
    `slate warning: t3 error (see ${log})`,
  ].join('\n'));
  assert.ok(!first.includes('2026-10-07T'), 'timestamps dropped');
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);

  // logSeen survives other session.json writers
  await nextTurn(dir);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);

  // a partial line waits until it is complete
  await append(dir, 'curator.log', '2026-10-07T10:03:00.000Z t4 part');
  assert.equal(await changeLine(dir, { waiting: true }), `${REMINDER}\nslate: memory still updating`);
  await append(dir, 'curator.log', 'ial: 0:stale F1\n');
  const later = await changeLine(dir, { waiting: false });
  assert.ok(later.includes(`slate warning: t4 partial: stale F1 (see ${log})`), later);
  assert.ok(!later.includes('t2 partial'), later);
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
  `slate: memory may not include turn ${t} yet — read ${path.join(dir, 'queue', `000${t}.md`)} before acting on recent instructions; a file that's gone was curated since, so reread the memory files.`;

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
  assert.ok(b.includes(`slate: memory may not include turns 1–3 yet — read ${conv}/0001.md to 0003.md before acting on recent instructions; a file that's gone was curated since, so reread the memory files.`), b.slice(0, 400));
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
  assert.ok(b.startsWith(`# slate memory\nslate: memory still updating; it may not include turn 1 yet — read ${file} before acting on recent instructions; a file that's gone was curated since, so reread the memory files.\n`), b.slice(0, 400));
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

// --- shared slates ---

test('memoryBlock reads shared items from the slate and now.md from the session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-inject-'));
  temps.push(root);
  const a = (await initSession(root, 'sa', 1)).dir;
  const b = (await initSession(root, 'sb', 2)).dir;
  await write(a, 'instructions.md', '# Instructions\n- [I1 t1] shared rule\n');
  await write(a, 'now.md', 'Goal A\n');
  await write(b, 'now.md', 'Goal B\n');
  const blockA = await memoryBlock(a);
  const blockB = await memoryBlock(b);
  assert.ok(blockA.includes('shared rule') && blockB.includes('shared rule'));
  assert.ok(blockA.includes('Goal A') && !blockA.includes('Goal B'));
  assert.ok(blockB.includes('Goal B') && !blockB.includes('Goal A'));
});

test('two sessions on one slate: a shared item shows as +I once in each change line', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-inject-'));
  temps.push(root);
  const a = (await initSession(root, 'sa', 1)).dir;
  const b = (await initSession(root, 'sb', 2)).dir;
  await memoryBlock(a);
  await memoryBlock(b);
  await append(a, 'instructions.md', '- [I1 t1] use pnpm\n');
  for (const dir of [a, b]) {
    assert.ok((await changeLine(dir)).includes('+I1 use pnpm'), dir);
    assert.ok(!(await changeLine(dir)).includes('+I1'), `${dir}: shown once`);
  }
});

test('old-format data: untagged items, old retired lines and a session.json without seen/from still inject', async () => {
  const dir = await session();
  await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify({ pid: 1, created: 'x', turn: 12 }));
  await write(dir, 'instructions.md', '# Instructions\n- [I3 t12] old item\n- [I4 t2] new item\n');
  await write(dir, 'superseded.md', '# Superseded\n- [I2 t1 retired t5] ZZ-GONE-ZZ (reason: why)\n');
  const block = await memoryBlock(dir);
  assert.ok(block.includes('- [I3 t12] old item') && block.includes('- [I4 t2] new item'));
  assert.ok(!block.includes('ZZ-GONE-ZZ'));
  assert.equal(typeof (await changeLine(dir)), 'string');
});

// --- topics ---

test('memoryBlock: a # Topics index after assumptions, one line per topic; topic items are not injected', async () => {
  const dir = await session();
  assert.ok(!(await memoryBlock(dir)).includes('\n\n# Topics\n'), 'no topics, no section');
  await write(dir, 'assumptions.md', '# Assumptions\n- [A1 t2] user is on macOS\n');
  await writeTopic(dir, 'canonical', '# Canonical URLs\n> Which URL wins.\n- [F3 t1] a (user)\n- [A4 t1] b\n- plain\n');
  await writeTopic(dir, 'build', '# Build\n> How it builds.\n- [F5 t1] c (user)\n');
  const b = await memoryBlock(dir);
  const index = `# Topics\nTopic files, in ${path.join(slateOf(dir), 'topics')}/:\n- build.md — Build: How it builds. (1)\n` +
    '- canonical.md — Canonical URLs: Which URL wins. (2)';
  assert.ok(b.endsWith(index), b.slice(-300));
  assert.ok(b.indexOf('- [A1 t2] user is on macOS') < b.indexOf('\n\n# Topics\n'));
  assert.ok(!b.includes('- [F3 t1] a (user)'), 'topic items stay in their files');
});

test('core: a topic title or summary carrying retired text is not shown', async () => {
  const dir = await session();
  await write(dir, 'superseded.md', '# Superseded\n- [F1 t1 retired t2] ZZ-GONE-ZZ (reason: r)\n');
  await writeTopic(dir, 'old', '# Old\n> ZZ-GONE-ZZ\n- [F2 t1] x (user)\n');
  await writeTopic(dir, 'tagged', '# [F9 t1 retired t2] y\n> fine\n');
  const b = await memoryBlock(dir);
  assert.ok(!b.includes('ZZ-GONE-ZZ') && !b.includes('retired t2'), b.slice(-400));
  assert.ok(b.includes('\n- old.md (1)\n'));
  assert.ok(b.endsWith('\n- tagged.md (0)'));
});

test('memoryBlock: over budget, the topic index shrinks to slugs and counts before facts spill', async () => {
  const dir = await session();
  for (let i = 1; i <= 40; i++) {
    await writeTopic(dir, `t${i}`, `# Topic ${i} ${'t'.repeat(60)}\n> ${'s'.repeat(150)}\n- [F${100 + i} t1] x (user)\n`);
  }
  await write(dir, 'facts.md', `# Facts\n${lines('F', 9, 600)}\n`);
  const b = await memoryBlock(dir);
  assert.ok(b.length <= MAX, `${b.length}`);
  assert.ok(b.includes(`- [F9 t1] ${'x'.repeat(600)}`), 'facts still shown in full');
  assert.ok(!b.includes('s'.repeat(150)) && !b.includes('t'.repeat(60)), 'titles and summaries dropped');
  assert.ok(b.includes('t1 (1)') && b.includes('t40 (1)'), 'every topic still named');
  assert.ok(b.includes(path.join(slateOf(dir), 'topics', '<slug>.md')), 'and where to find it');
});

// Topics like a real slate's after the reorganize pass: slug, title, summary, item count.
const REAL_TOPICS = [
  ['calypso-seo-menu', 'Calypso SEO menu', 'Where the SEO settings live in Calypso and how the menu item is gated.', 6],
  ['canonical-urls', 'Canonical URLs', 'Rules for rel=canonical output, pagination and variants.', 9],
  ['feature-flags', 'Feature flags', 'Which flags gate the SEO tools and how the rollout is staged.', 4],
  ['general', 'General', 'Items without a more specific topic.', 12],
  ['hreflang', 'Hreflang and localization', 'Hreflang tags, locales and the de-de site layout.', 3],
  ['linear-project', 'Linear project', 'Issues, milestones and owners for the SEO project in Linear.', 8],
  ['meta-tags', 'Meta tags', 'Title and description templates, length limits and fallbacks.', 5],
  ['open-graph', 'Open Graph and social', 'og: and twitter: tags, default images and per-post overrides.', 4],
  ['performance', 'Performance', 'LCP, image formats and the lazy-loading rollout.', 4],
  ['redirects', 'Redirects', '301 rules, trailing slashes and the legacy URL map.', 3],
  ['releases', 'Releases and workflow', 'Release cadence, schedule, tests and changelog conventions.', 7],
  ['robots-indexing', 'Robots and indexing', 'robots.txt, noindex behavior on staging and search pages.', 4],
  ['sitemaps', 'Sitemaps', 'Sitemap structure, limits, exclusions and PR #101 image entries.', 6],
  ['structured-data', 'Structured data', 'JSON-LD schema for products, breadcrumbs, organization and Rich Results status.', 5],
  ['testing', 'Testing', 'Unit, e2e and manual test steps for SEO changes.', 3],
];
// Item lines of `total` chars or just under, `size` chars each, with origin tags like a real slate's.
function capLines(prefix, total, size) {
  const out = [];
  for (let i = 1, used = 0; used + size <= total; i++, used += size) {
    const head = `- [${prefix}${i} t12@82b3114c] `;
    out.push(`${head}${'x'.repeat(size - head.length - ' (user)'.length)} (user)`);
  }
  return out.join('\n');
}
// A session whose paths are as long as a real one's (~/slate/<name>/.sessions/<uuid>): a temp
// folder's are ~45 chars longer, and the rules and index name them ~10 times.
async function realPathSession() {
  const root = await fs.mkdtemp('/tmp/sl-');
  temps.push(root);
  return (await initSession(root, '82b3114c-5e73-4142-ae8c-b8564fbac2d9', 1, 'jetpack-seo')).dir;
}
// A real slate's other sizes: 7 instructions of 1.2k chars and a 10-line now.md of 1.75k.
async function realSizeMemory(dir, factChars, assumptionChars) {
  await write(dir, 'instructions.md', `# Instructions\n${capLines('I', 1190, 170)}\n`);
  await write(dir, 'now.md', `${Array.from({ length: 10 }, (_, i) => `${i + 1}. ${'n'.repeat(170)}`).join('\n')}\n`);
  await write(dir, 'facts.md', `# Facts\n${capLines('F', factChars, 100)}\n`);
  await write(dir, 'assumptions.md', `# Assumptions\n${capLines('A', assumptionChars, 100)}\n`);
  let id = 100;
  for (const [slug, title, summary, n] of REAL_TOPICS) {
    const items = Array.from({ length: n }, () => `- [F${id++} t1] a fact (user)`).join('\n');
    await writeTopic(dir, slug, `# ${title}\n> ${summary}\n${items}\n`);
  }
}

// Before the index, a real slate's block at the key caps is ~9.1k chars (rules 1.6k, instructions
// 1.2k, now 1.75k, key files 4.5k): ~870 left, and these 15 topics need ~1.55k with summaries.
test('memoryBlock: the topics folder is named once; 15 real-size topics keep titles and summaries next to real-size memory with key files four-fifths full', async () => {
  const dir = await realPathSession();
  await realSizeMemory(dir, 2400, 1200);
  const b = await memoryBlock(dir);
  assert.ok(b.length <= MAX, `${b.length}`);
  const folder = `${path.join(slateOf(dir), 'topics')}/`;
  const index = b.slice(b.indexOf('\n\n# Topics\n'));
  assert.ok(index.startsWith(`\n\n# Topics\nTopic files, in ${folder}:\n`), index.slice(0, 200));
  assert.equal(index.split(folder).length, 2, 'the folder appears once');
  for (const [slug, title, summary, n] of REAL_TOPICS) {
    assert.ok(index.includes(`\n- ${slug}.md — ${title}: ${summary} (${n})`), slug);
  }
  assert.ok(b.includes(capLines('F', 2400, 100)) && b.includes(capLines('A', 1200, 100)), 'key files in full');
  assert.ok(!b.includes('too long to show') && !b.includes('more; read'), 'nothing spilled');
});

test('memoryBlock: with key files at their caps, the index drops summaries, keeps titles, and facts stay in full', async () => {
  const dir = await realPathSession();
  await realSizeMemory(dir, 3000, 1500);
  const b = await memoryBlock(dir);
  assert.ok(b.length <= MAX, `${b.length}`);
  const index = b.slice(b.indexOf('\n\n# Topics\n'));
  assert.ok(index.startsWith(`\n\n# Topics\nTopic files, in ${path.join(slateOf(dir), 'topics')}/:\n`), index.slice(0, 200));
  for (const [slug, title, summary, n] of REAL_TOPICS) {
    assert.ok(index.includes(`\n- ${slug}.md — ${title} (${n})`), slug);
    assert.ok(!index.includes(summary), `${slug}: summary dropped`);
  }
  assert.ok(b.includes(capLines('F', 3000, 100)) && b.includes(capLines('A', 1500, 100)), 'key files in full');
  assert.ok(!b.includes('too long to show') && !b.includes('more; read'), 'nothing spilled');
});

test('memoryBlock: seen covers topic items, so the next change line is quiet', async () => {
  const dir = await session();
  await writeTopic(dir, 'build', '# Build\n> x\n- [F5 t1] c (user)\n');
  await memoryBlock(dir);
  assert.equal(await changeLine(dir), REMINDER);
});

test('changeLine: topic adds show as +N in <slug>; a move shows nothing; a promoted item shows once as a key item', async () => {
  const dir = await session();
  await write(dir, 'facts.md', '# Facts\n- [F1 t1] key fact (user)\n');
  await writeTopic(dir, 'canonical', '# Canonical\n> x\n- [F2 t1] old (user)\n');
  await memoryBlock(dir);
  await fs.appendFile(topicPath(dir, 'canonical'), '- [F3 t2] new one (user)\n- [A4 t2] new two\n');
  assert.equal(await changeLine(dir), `${REMINDER}\nslate: +2 in canonical`);

  // F1 demoted from key to canonical; F2 promoted from canonical to key.
  await write(dir, 'facts.md', '# Facts\n- [F2 t1] old (user)\n');
  await writeTopic(dir, 'canonical', '# Canonical\n> x\n- [F3 t2] new one (user)\n- [A4 t2] new two\n- [F1 t1] key fact (user)\n');
  assert.equal(await changeLine(dir), `${REMINDER}\nslate: +F2 old (user)`);
  assert.equal(await changeLine(dir), REMINDER, 'shown once');

  await writeTopic(dir, 'other', '# Other\n> y\n- [F1 t1] key fact (user)\n');
  await writeTopic(dir, 'canonical', '# Canonical\n> x\n- [A4 t2] new two\n');
  assert.equal(await changeLine(dir), `${REMINDER}\nslate: retired F3`, 'a move between topics is no change');
});

test('changeLine: at most 3 topics by name, the most added first, then +M more', async () => {
  const dir = await session();
  await memoryBlock(dir);
  let n = 0;
  const items = (k) => Array.from({ length: k }, () => `- [F${++n} t1] f${n} (user)\n`).join('');
  for (const [slug, k] of [['a', 1], ['b', 3], ['c', 2], ['d', 1], ['e', 2]]) await writeTopic(dir, slug, `# ${slug}\n> s\n${items(k)}`);
  assert.equal(await changeLine(dir), `${REMINDER}\nslate: +3 in b · +2 in c · +2 in e · +2 more`);
  assert.equal(await changeLine(dir), REMINDER);
});
