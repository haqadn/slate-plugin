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
    const line = formatItem({ id, turn: 3, session: '82b3114c', text });
    assert.equal(line, `- [${id} t3@82b3114c] ${text}`);
    assert.deepEqual(parseItemLine(line), { id, type: id[0], num: Number(id.slice(1)), turn: 3, session: '82b3114c', text });
  }
});

test('an item without a session (adopted, or old) has no @ part', () => {
  assert.equal(formatItem({ id: 'I5', turn: 0, session: null, text: 'prefer tabs' }), '- [I5 t0] prefer tabs');
  assert.equal(formatItem({ id: 'I5', turn: 0, text: 'prefer tabs' }), '- [I5 t0] prefer tabs');
});

test('old tags parse with session null', () => {
  assert.deepEqual(parseItemLine('- [I3 t12] use npm'), { id: 'I3', type: 'I', num: 3, turn: 12, session: null, text: 'use npm' });
  assert.deepEqual(parseItemLine('- [I3 t0] prefer tabs'), { id: 'I3', type: 'I', num: 3, turn: 0, session: null, text: 'prefer tabs' });
  assert.deepEqual(parseRetiredLine('- [I1 t1 retired t2] x (reason: y)'), {
    id: 'I1', type: 'I', num: 1, turn: 1, session: null, retiredTurn: 2, retiredSession: null, text: 'x', reason: 'y',
  });
});

test('an old item retired with a new tag keeps both parts', () => {
  const r = parseRetiredLine('- [I3 t12 retired t5@9f0e1a2b] use npm (reason: pnpm now)');
  assert.equal(r.session, null);
  assert.equal(r.retiredSession, '9f0e1a2b');
  assert.equal(formatRetired(r), '- [I3 t12 retired t5@9f0e1a2b] use npm (reason: pnpm now)');
});

test('parseItemLine rejects non-items', () => {
  for (const l of ['- [I3] no turn', '- [X1 t1] x', '[I1 t1] x', ' - [I1 t1] x', '- [I1 t1 retired t2] x (reason: y)', '- plain', '',
    '- [I1 t1@] empty session', '- [I1 t1@123456789] session over 8 chars', '- [I1 t1@a b] space', '- [I1 @ab] no turn']) {
    assert.equal(parseItemLine(l), null, l);
  }
});

test('retired round-trip, reason with parentheses', () => {
  const r = {
    id: 'I12', type: 'I', num: 12, turn: 3, session: '82b3114c', retiredTurn: 5, retiredSession: '9f0e1a2b',
    text: 'use npm (v10) [x]', reason: 'user said pnpm (see msg 4)',
  };
  const line = formatRetired(r);
  assert.equal(line, '- [I12 t3@82b3114c retired t5@9f0e1a2b] use npm (v10) [x] (reason: user said pnpm (see msg 4))');
  assert.deepEqual(parseRetiredLine(line), r);
  const old = { ...r, session: null, retiredSession: null };
  assert.equal(formatRetired(old), '- [I12 t3 retired t5] use npm (v10) [x] (reason: user said pnpm (see msg 4))');
  assert.deepEqual(parseRetiredLine(formatRetired(old)), old);
});

test('parseRetiredLine rejects missing reason and non-retired', () => {
  assert.equal(parseRetiredLine('- [I1 t1 retired t2] use npm'), null);
  assert.equal(parseRetiredLine('- [I1 t1] use npm'), null);
  assert.equal(parseRetiredLine('- [I1 t1 retired t2] x (reason: )').reason, '');
});

test('parseMemoryFile sorts lines', () => {
  const text = [
    '# Instructions', '', '## Section', '- [I1 t1] a', '- [I2 t2 retired t3] b (reason: c)',
    'free line', '- plain bullet', '', '- [I3] no turn', '#todo', '', '- [I4 t2@82b3114c] d',
    '- [I5 t2@82b3114c retired t3@9f0e1a2b] e (reason: f)',
  ].join('\n');
  const p = parseMemoryFile(text);
  assert.deepEqual(p.items.map(i => i.id), ['I1', 'I4']);
  assert.deepEqual(p.retired.map(i => i.id), ['I2', 'I5']);
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
  const lf = '# T\n- [I1 t1] a\n- [I2 t1 retired t2] b (reason: c)\n- [I3 t1@ab] d\nplain\n';
  assert.deepEqual(parseMemoryFile(lf.replace(/\n/g, '\r\n')), parseMemoryFile(lf));
});
