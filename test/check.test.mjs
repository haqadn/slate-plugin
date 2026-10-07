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
