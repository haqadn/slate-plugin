import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEM_FILES, MEMORY_FILES, isHeading, parseItemLine, formatItem,
  parseRetiredLine, formatRetired, parseMemoryFile,
} from '../plugins/slate/scripts/lib/items.mjs';

test('constants', () => {
  assert.deepEqual(ITEM_FILES, { I: 'instructions.md', A: 'assumptions.md', F: 'facts.md' });
  assert.deepEqual(MEMORY_FILES, ['instructions.md', 'assumptions.md', 'facts.md', 'now.md', 'superseded.md']);
});

test('isHeading', () => {
  for (const l of ['# T', '##', '###### x']) assert.equal(isHeading(l), true, l);
  for (const l of ['#1 priority', '#todo', '####### x', ' # x', '- # x']) assert.equal(isHeading(l), false, l);
});

test('item round-trips for I, A, F', () => {
  for (const id of ['I12', 'A1', 'F100']) {
    const text = 'use [brackets] (parens) and ünïcode ✓ at src/[id]/x.ts';
    const line = formatItem({ id, turn: 3, text });
    assert.equal(line, `- [${id} t3] ${text}`);
    assert.deepEqual(parseItemLine(line), { id, type: id[0], num: Number(id.slice(1)), turn: 3, text });
  }
});

test('parseItemLine rejects non-items', () => {
  for (const l of ['- [I3] no turn', '- [X1 t1] x', '[I1 t1] x', ' - [I1 t1] x', '- [I1 t1 retired t2] x (reason: y)', '- plain', '']) {
    assert.equal(parseItemLine(l), null, l);
  }
});

test('retired round-trip, reason with parentheses', () => {
  const r = { id: 'I1', type: 'I', num: 1, turn: 1, retiredTurn: 2, text: 'use npm (v10) [x]', reason: 'user said pnpm (see msg 4)' };
  const line = formatRetired(r);
  assert.equal(line, '- [I1 t1 retired t2] use npm (v10) [x] (reason: user said pnpm (see msg 4))');
  assert.deepEqual(parseRetiredLine(line), r);
});

test('parseRetiredLine rejects missing reason and non-retired', () => {
  assert.equal(parseRetiredLine('- [I1 t1 retired t2] use npm'), null);
  assert.equal(parseRetiredLine('- [I1 t1] use npm'), null);
  assert.equal(parseRetiredLine('- [I1 t1 retired t2] x (reason: )').reason, '');
});

test('parseMemoryFile sorts lines', () => {
  const text = [
    '# Instructions', '', '## Section', '- [I1 t1] a', '- [I2 t2 retired t3] b (reason: c)',
    'free line', '- plain bullet', '', '- [I3] no turn', '#todo', '',
  ].join('\n');
  const p = parseMemoryFile(text);
  assert.deepEqual(p.items.map(i => i.id), ['I1']);
  assert.deepEqual(p.retired.map(i => i.id), ['I2']);
  assert.deepEqual(p.plain, ['free line', '- plain bullet', '- [I3] no turn', '#todo']);
});

test('parseMemoryFile handles empty and non-title first line', () => {
  assert.deepEqual(parseMemoryFile(''), { items: [], retired: [], plain: [] });
  assert.deepEqual(parseMemoryFile('only text').plain, ['only text']);
});

test('leading zeros normalize to the same ID', () => {
  assert.equal(parseItemLine('- [I07 t1] x').id, 'I7');
  assert.equal(parseRetiredLine('- [A007 t1 retired t2] x (reason: y)').id, 'A7');
});

test('CRLF parses like LF', () => {
  const lf = '# T\n- [I1 t1] a\n- [I2 t1 retired t2] b (reason: c)\nplain\n';
  assert.deepEqual(parseMemoryFile(lf.replace(/\n/g, '\r\n')), parseMemoryFile(lf));
});
