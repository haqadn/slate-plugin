import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCuratorEdit } from '../plugins/slate/scripts/lib/check.mjs';

const mem = (o = {}) => ({
  'instructions.md': '# Instructions\n', 'assumptions.md': '# Assumptions\n', 'facts.md': '# Facts\n',
  'now.md': '# Now\n', 'superseded.md': '# Superseded\n', ...o,
});
const BASE = mem({
  'instructions.md': '# Instructions\n- [I1 t1] use npm\n- [I2 t2] always run tests\n',
  'facts.md': '# Facts\n- [F2 t2] repo is at /srv/app (source: user)\n',
  'superseded.md': '# Superseded\n- [I6 t1 retired t2] old (reason: replaced)\n',
});
const withFile = (b, f, text) => ({ ...b, [f]: text });
const has = (v, s) => assert.ok(v.some(x => x.includes(s)), `expected "${s}" in ${JSON.stringify(v)}`);

test('no change passes', () => {
  assert.deepEqual(checkCuratorEdit(BASE, { ...BASE }, 5), []);
});

test('add I7 t5 passes', () => {
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7 t5] never force-push\n');
  assert.deepEqual(checkCuratorEdit(BASE, after, 5), []);
});

test('retired lines count toward previous maximum (I6 retired)', () => {
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I5 t5] x\n');
  has(checkCuratorEdit(BASE, after, 5), 'I5');
});

test('IDs are per type', () => {
  const after = withFile(BASE, 'assumptions.md', '# Assumptions\n- [A1 t5] assume linux\n');
  assert.deepEqual(checkCuratorEdit(BASE, after, 5), []);
});

test('correct supersede passes', () => {
  const after = mem({
    'instructions.md': '# Instructions\n- [I2 t2] always run tests\n- [I7 t5] use pnpm\n',
    'facts.md': BASE['facts.md'],
    'superseded.md': BASE['superseded.md'] + '- [I1 t1 retired t5] use npm (reason: user switched to pnpm)\n',
  });
  assert.deepEqual(checkCuratorEdit(BASE, after, 5), []);
});

test('moving F2 between files with same text passes', () => {
  const after = mem({
    ...BASE,
    'facts.md': '# Facts\n',
    'assumptions.md': '# Assumptions\n- [F2 t2] repo is at /srv/app (source: user)\n',
  });
  assert.deepEqual(checkCuratorEdit(BASE, after, 5), []);
});

test('adopting a plain bullet as t0 with identical text passes', () => {
  const before = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- use tabs\n');
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I4 t0] use tabs\n');
  has(checkCuratorEdit(before, after, 5), 'I4');
  const ok = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7 t0] use tabs\n');
  assert.deepEqual(checkCuratorEdit(before, ok, 5), []);
});

test('adopting plain bullet whose max is low uses next number', () => {
  const b = mem({ 'instructions.md': '# I\n- [I3 t1] x\n- use tabs\n' });
  const a = mem({ 'instructions.md': '# I\n- [I3 t1] x\n- [I4 t0] use tabs\n' });
  assert.deepEqual(checkCuratorEdit(b, a, 5), []);
});

test('t0 item that adopts nothing fails', () => {
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7 t0] invented\n');
  has(checkCuratorEdit(BASE, after, 5), 'I7');
});

test('adopted text altered fails (plain lost)', () => {
  const b = mem({ 'instructions.md': '# I\n- use tabs\n' });
  const a = mem({ 'instructions.md': '# I\n- [I1 t0] use tabs always\n' });
  const v = checkCuratorEdit(b, a, 5);
  has(v, 'plain line lost: "use tabs"');
  has(v, 'I1');
});

test('reworded live item fails', () => {
  const after = withFile(BASE, 'instructions.md', '# Instructions\n- [I1 t1] use yarn\n- [I2 t2] always run tests\n');
  assert.deepEqual(checkCuratorEdit(BASE, after, 5), ['I1 reworded']);
});

test('trailing-space change counts as reworded (exact equality)', () => {
  const after = withFile(BASE, 'instructions.md', '# Instructions\n- [I1 t1] use npm \n- [I2 t2] always run tests\n');
  has(checkCuratorEdit(BASE, after, 5), 'I1 reworded');
});

test('deleted item fails', () => {
  const after = withFile(BASE, 'instructions.md', '# Instructions\n- [I2 t2] always run tests\n');
  assert.deepEqual(checkCuratorEdit(BASE, after, 5), ['I1 deleted']);
});

test('retired line without reason fails', () => {
  const after = mem({
    ...BASE,
    'instructions.md': '# Instructions\n- [I2 t2] always run tests\n',
    'superseded.md': BASE['superseded.md'] + '- [I1 t1 retired t5] use npm\n',
  });
  has(checkCuratorEdit(BASE, after, 5), 'I1');
});

test('retired line with empty or blank reason fails', () => {
  for (const reason of ['', '  ']) {
    const after = mem({
      ...BASE,
      'instructions.md': '# Instructions\n- [I2 t2] always run tests\n',
      'superseded.md': BASE['superseded.md'] + `- [I1 t1 retired t5] use npm (reason: ${reason})\n`,
    });
    has(checkCuratorEdit(BASE, after, 5), 'I1 retired without reason');
  }
});

test('retired with wrong turn fails', () => {
  const after = mem({
    ...BASE,
    'instructions.md': '# Instructions\n- [I2 t2] always run tests\n',
    'superseded.md': BASE['superseded.md'] + '- [I1 t1 retired t4] use npm (reason: switched)\n',
  });
  has(checkCuratorEdit(BASE, after, 5), 'I1 retired at t4, expected t5');
});

test('retired with changed text fails', () => {
  const after = mem({
    ...BASE,
    'instructions.md': '# Instructions\n- [I2 t2] always run tests\n',
    'superseded.md': BASE['superseded.md'] + '- [I1 t1 retired t5] use Npm (reason: switched)\n',
  });
  has(checkCuratorEdit(BASE, after, 5), 'I1 reworded');
});

test('removing a line from superseded.md fails', () => {
  const after = withFile(BASE, 'superseded.md', '# Superseded\n');
  const v = checkCuratorEdit(BASE, after, 5);
  has(v, 'superseded.md lost line');
});

test('editing a superseded line fails', () => {
  const after = withFile(BASE, 'superseded.md', '# Superseded\n- [I6 t1 retired t2] old (reason: other)\n');
  has(checkCuratorEdit(BASE, after, 5), 'superseded.md lost line');
});

test('new ID not above previous max fails', () => {
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I5 t5] x\n');
  has(checkCuratorEdit(BASE, after, 5), 'I5 not above previous max I6');
});

test('duplicated new ID fails', () => {
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7 t5] x\n- [I7 t5] y\n');
  has(checkCuratorEdit(BASE, after, 5), 'I7 duplicated');
});

test('new ID duplicating an existing one across files fails', () => {
  const after = withFile(BASE, 'assumptions.md', '# A\n- [I1 t5] again\n');
  has(checkCuratorEdit(BASE, after, 5), 'I1 duplicated');
});

test('copy left behind after retiring fails (live and retired)', () => {
  const after = mem({
    ...BASE,
    'superseded.md': BASE['superseded.md'] + '- [I1 t1 retired t5] use npm (reason: r)\n',
  });
  has(checkCuratorEdit(BASE, after, 5), 'I1 duplicated');
});

test('new item with wrong turn fails', () => {
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7 t4] x\n');
  has(checkCuratorEdit(BASE, after, 5), 'I7 tagged t4, expected t5');
});

test('vanished plain bullet fails', () => {
  const before = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- use tabs\n');
  has(checkCuratorEdit(before, BASE, 5), 'plain line lost: "use tabs"');
});

test('reworded plain bullet fails', () => {
  const before = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- use tabs\n');
  const after = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- use tabs please\n');
  has(checkCuratorEdit(before, after, 5), 'plain line lost: "use tabs"');
});

test('plain line without bullet is identified by whole line', () => {
  const before = withFile(BASE, 'facts.md', BASE['facts.md'] + 'loose note\n');
  has(checkCuratorEdit(before, BASE, 5), 'plain line lost: "loose note"');
  assert.deepEqual(checkCuratorEdit(before, before, 5), []);
});

test('plain line may move to another item file', () => {
  const before = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- use tabs\n');
  const after = withFile(BASE, 'facts.md', BASE['facts.md'] + '- use tabs\n');
  assert.deepEqual(checkCuratorEdit(before, after, 5), []);
});

test('now.md over 10 non-blank lines fails; 10 passes', () => {
  const lines = n => Array.from({ length: n }, (_, i) => `step ${i}`).join('\n\n') + '\n';
  assert.deepEqual(checkCuratorEdit(BASE, withFile(BASE, 'now.md', lines(10)), 5), []);
  has(checkCuratorEdit(BASE, withFile(BASE, 'now.md', lines(11)), 5), 'now.md has 11 lines');
});

test('now.md free text lines are not plain lines', () => {
  const before = withFile(BASE, 'now.md', '# Now\n- fix the bug\n');
  assert.deepEqual(checkCuratorEdit(before, BASE, 5), []);
});

test('Review Focus 3: "- [I3] no turn" is a plain line', () => {
  const before = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I3] no turn\n');
  assert.deepEqual(checkCuratorEdit(before, before, 5), []);
  has(checkCuratorEdit(before, BASE, 5), 'plain line lost: "[I3] no turn"');
});

test('missing file in after fails', () => {
  const { 'facts.md': _, ...after } = BASE;
  has(checkCuratorEdit(BASE, after, 5), 'facts.md missing');
});

test('retired line outside superseded.md and item in superseded.md fail', () => {
  const a1 = withFile(BASE, 'facts.md', BASE['facts.md'] + '- [F5 t5 retired t5] x (reason: y)\n');
  has(checkCuratorEdit(BASE, a1, 5), 'F5 retired line outside superseded.md');
  const a2 = withFile(BASE, 'superseded.md', BASE['superseded.md'] + '- [F5 t5] x\n');
  has(checkCuratorEdit(BASE, a2, 5), 'F5 live item in superseded.md');
});

// ---- fix round 1 ----
const PLAIN = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- use tabs\n');

test('FIX1: new retired line needs retired turn and non-empty reason', () => {
  const bad = withFile(PLAIN, 'superseded.md', PLAIN['superseded.md'] + '- [I7 t0 retired t0] use tabs (reason: )\n');
  const a = withFile(bad, 'instructions.md', BASE['instructions.md']);
  const v = checkCuratorEdit(PLAIN, a, 5);
  has(v, 'I7 retired at t0, expected t5');
  has(v, 'I7 retired without reason');
});

test('FIX1: adopting a plain bullet straight into superseded passes', () => {
  const a = mem({
    ...BASE,
    'superseded.md': BASE['superseded.md'] + '- [I7 t0 retired t5] use tabs (reason: user switched)\n',
  });
  assert.deepEqual(checkCuratorEdit(PLAIN, a, 5), []);
});

test('FIX1: new retired line created and retired this turn passes; wrong tag fails', () => {
  const ok = withFile(BASE, 'superseded.md', BASE['superseded.md'] + '- [I7 t5 retired t5] x (reason: y)\n');
  assert.deepEqual(checkCuratorEdit(BASE, ok, 5), []);
  const bad = withFile(BASE, 'superseded.md', BASE['superseded.md'] + '- [I7 t3 retired t5] x (reason: y)\n');
  has(checkCuratorEdit(BASE, bad, 5), 'I7 tagged t3, expected t5');
});

const HB = mem({
  'instructions.md': '# Instructions\n## Never do these\n- push to main\n',
  'superseded.md': '# Superseded\n## Old\n- [I9 t1 retired t2] old (reason: r)\n',
});

test('FIX2: deleting a non-title heading fails', () => {
  const a = withFile(HB, 'instructions.md', '# Instructions\n- push to main\n');
  has(checkCuratorEdit(HB, a, 5), 'heading lost: "## Never do these"');
  const a2 = withFile(HB, 'superseded.md', '# Superseded\n- [I9 t1 retired t2] old (reason: r)\n');
  has(checkCuratorEdit(HB, a2, 5), 'heading lost: "## Old"');
});

test('FIX2: title may change, heading may move files, added headings are fine', () => {
  assert.deepEqual(checkCuratorEdit(HB, withFile(HB, 'instructions.md', '# Renamed\n## Never do these\n- push to main\n## New\n'), 5), []);
  const moved = mem({ ...HB, 'instructions.md': '# Instructions\n- push to main\n', 'facts.md': '# Facts\n## Never do these\n' });
  assert.deepEqual(checkCuratorEdit(HB, moved, 5), []);
});

test('FIX2: duplicate headings are counted', () => {
  const b = withFile(HB, 'facts.md', '# Facts\n## Same\n## Same\n');
  const a = withFile(HB, 'facts.md', '# Facts\n## Same\n');
  has(checkCuratorEdit(b, a, 5), 'heading lost: "## Same"');
});

test('FIX3: pre-existing duplicate or misplaced lines do not freeze a no-op', () => {
  const b = mem({
    ...BASE,
    'assumptions.md': '# A\n- [I1 t1] use npm\n',
    'facts.md': BASE['facts.md'] + '- [F8 t1 retired t2] r (reason: z)\n',
    'superseded.md': BASE['superseded.md'] + '- [I8 t1] live in superseded\n',
  });
  assert.deepEqual(checkCuratorEdit(b, { ...b }, 5), []);
});

test('FIX3: a newly added duplicate is still flagged on top of an old one', () => {
  const b = withFile(BASE, 'assumptions.md', '# A\n- [I1 t1] use npm\n');
  const a = withFile(b, 'facts.md', b['facts.md'] + '- [I1 t1] use npm\n');
  has(checkCuratorEdit(b, a, 5), 'I1 duplicated');
});

test('FIX4: new malformed item-looking line is a violation', () => {
  const a = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7] use pnpm\n');
  has(checkCuratorEdit(BASE, a, 5), 'malformed item line: "- [I7] use pnpm"');
  const a2 = withFile(BASE, 'facts.md', BASE['facts.md'] + '- [Q1 t5] x\n- [I7 t5 retired t5] no reason\n');
  has(checkCuratorEdit(BASE, a2, 5), 'malformed item line: "- [I7 t5 retired t5] no reason"');
});

test('FIX4: pre-existing malformed line is not flagged, even when moved', () => {
  const b = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7] old\n');
  assert.deepEqual(checkCuratorEdit(b, b, 5), []);
  const moved = mem({ ...BASE, 'facts.md': BASE['facts.md'] + '- [I7] old\n' });
  assert.deepEqual(checkCuratorEdit(b, moved, 5), []);
});

test('FIX5: leading zeros do not create distinct IDs', () => {
  const a = withFile(BASE, 'instructions.md', '# Instructions\n- [I01 t1] use npm\n- [I2 t2] always run tests\n');
  assert.deepEqual(checkCuratorEdit(BASE, a, 5), []);
  const dup = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I01 t5] again\n');
  has(checkCuratorEdit(BASE, dup, 5), 'I1 duplicated');
  const reword = withFile(BASE, 'instructions.md', '# Instructions\n- [I001 t1] changed\n- [I2 t2] always run tests\n');
  has(checkCuratorEdit(BASE, reword, 5), 'I1 reworded');
});

test('FIX6: CRLF files behave like LF', () => {
  const crlf = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
  const b = crlf(PLAIN);
  assert.deepEqual(checkCuratorEdit(b, b, 5), []);
  const a = crlf(withFile(PLAIN, 'instructions.md', PLAIN['instructions.md'] + '- [I7 t5] new\n'));
  assert.deepEqual(checkCuratorEdit(b, a, 5), []);
  has(checkCuratorEdit(b, crlf(BASE), 5), 'plain line lost: "use tabs"');
  const sup = crlf(withFile(BASE, 'superseded.md', BASE['superseded.md'] + '- [I7 t5 retired t5] x (reason: y)\n'));
  assert.deepEqual(checkCuratorEdit(crlf(BASE), sup, 5), []);
});

// ---- fix round 2 ----
test('R2-1: no-op on an old different-text duplicate ID passes; rewording one copy fails', () => {
  const b = mem({
    ...BASE,
    'assumptions.md': '# A\n- [I1 t1] something else\n',
  });
  assert.deepEqual(checkCuratorEdit(b, { ...b }, 5), []);
  const a = withFile(b, 'assumptions.md', '# A\n- [I1 t1] changed\n');
  has(checkCuratorEdit(b, a, 5), 'I1 reworded');
  const a2 = withFile(b, 'assumptions.md', '# A\n');
  has(checkCuratorEdit(b, a2, 5), 'I1 reworded'); // dropping one copy is not allowed either
});

test('R2-1: I07 and I7 both present before is a passing no-op', () => {
  const b = mem({ 'instructions.md': '# I\n- [I07 t1] a\n- [I7 t1] b\n' });
  assert.deepEqual(checkCuratorEdit(b, { ...b }, 5), []);
});

test('R2-2: malformed line cannot be laundered through now.md', () => {
  const b = withFile(BASE, 'now.md', '# Now\n- [I7] use pnpm\n');
  const a = withFile(BASE, 'instructions.md', BASE['instructions.md'] + '- [I7] use pnpm\n');
  has(checkCuratorEdit(b, a, 5), 'malformed item line: "- [I7] use pnpm"');
});
