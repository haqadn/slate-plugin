import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rulesText, memoryBlock, changeLine } from '../plugins/slate/scripts/lib/inject.mjs';
import { initSession, readSession, writeSession, nextTurn } from '../plugins/slate/scripts/lib/session.mjs';

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
    '{{dir}}/instructions.md', '{{dir}}/reports/<slug>.md', '{{dir}}/superseded.md', '{{dir}}/conversation/NNNN.md',
    'Return ≤10 lines']) {
    assert.ok(raw.includes(s), `rules.md lacks ${JSON.stringify(s)}`);
  }
});

test('rulesText fills every {{dir}} and stays under ~1,500 chars with a real path', async () => {
  const dir = '/Users/someone/Projects/my-project/.slate/0b7e8f5c-1234-4abc-9def-0123456789ab';
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
  assert.ok(line.includes('t2 restored: superseded.md lost line: "…"; I9 deleted'), line);

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
  assert.ok(b.includes(path.join(dir, 'instructions.md')));
  assert.ok(b.includes(COMPACT_LINE));
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
    '2026-10-07T10:01:00.000Z t2 restored: I3 removed without retiring\n' +
    '2026-10-07T10:02:00.000Z t3 error: claude exited 1\n');
  const first = await changeLine(dir, { waiting: false });
  assert.ok(first.includes('t2 restored: I3 removed without retiring'), first);
  assert.ok(first.includes('t3 error: claude exited 1'), first);
  assert.ok(!first.includes('kept'), first);
  assert.ok(!first.includes('2026-10-07T'), 'timestamps dropped');
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);

  // logSeen survives other session.json writers
  await nextTurn(dir);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);

  // a partial line waits until it is complete
  await append(dir, 'curator.log', '2026-10-07T10:03:00.000Z t4 rest');
  assert.equal(await changeLine(dir, { waiting: true }), `${REMINDER}\nslate: memory still updating`);
  await append(dir, 'curator.log', 'ored: F1 text changed\n');
  const later = await changeLine(dir, { waiting: false });
  assert.ok(later.includes('t4 restored: F1 text changed'), later);
  assert.ok(!later.includes('t2 restored'), later);
  assert.equal(await changeLine(dir, { waiting: false }), REMINDER);
});

test('changeLine: a log replaced by a shorter one is read from the start', async () => {
  const dir = await session();
  await write(dir, 'curator.log', `${'2026-10-07T10:00:00.000Z t1 ok: fine\n'.repeat(5)}`);
  await changeLine(dir, { waiting: false });
  await write(dir, 'curator.log', '2026-10-07T11:00:00.000Z t9 error: boom\n');
  assert.ok((await changeLine(dir, { waiting: false })).includes('t9 error: boom'));
});

test('changeLine stays within the hook cap with huge items and many warnings', async () => {
  const dir = await session();
  await write(dir, 'instructions.md', `# Instructions\n${lines('I', 5, 3000)}\n`);
  await write(dir, 'curator.log', `${'2026-10-07T10:00:00.000Z t1 error: ' + 'e'.repeat(5000) + '\n'}`.repeat(50));
  const line = await changeLine(dir, { waiting: false });
  assert.ok(line.length <= MAX, `${line.length}`);
  assert.ok(line.startsWith(REMINDER));
});
