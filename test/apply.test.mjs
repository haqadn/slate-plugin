import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  applyChanges, CHANGE_SCHEMA, REORGANIZE_SCHEMA, FACTS_CAP, ASSUMPTIONS_CAP, ERROR_KINDS,
} from '../plugins/slate/scripts/lib/apply.mjs';
import { createSession, slateOf } from '../plugins/slate/scripts/lib/slate.mjs';
import { readMemory, writeMemory } from '../plugins/slate/scripts/lib/session.mjs';
import { acquire } from '../plugins/slate/scripts/lib/lock.mjs';
import { initSession } from './helpers.mjs';

const APPLY = new URL('../plugins/slate/scripts/lib/apply.mjs', import.meta.url).href;
const LOCK = new URL('../plugins/slate/scripts/lib/lock.mjs', import.meta.url).href;
const SID = '82b3114c-5d1e-4c2a-9a0b-1f2e3d4c5b6a';
const TAG = 't5@82b3114c';
const OPTS = { turn: 5, sessionId: SID };
// op index, kind, then up to two IDs: never item text.
const SAFE_TOKEN = /^(?:\d+:)?[a-z][a-z -]*?(?: [IAF]\d+){0,2}$/;

const temps = [];
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
const exists = (p) => fs.access(p).then(() => true, () => false);

const BASE = {
  'instructions.md': '# Instructions\n\n## Build\n- [I1 t1] use npm\n- [I2 t3@0ther000] run tests first\n\n## Style\n- [I4 t2] no semicolons\n',
  'assumptions.md': '# Assumptions\n- [A1 t2] CI runs on push\n',
  'facts.md': '# Facts\n- [F2 t1] Node 24 (package.json)\n',
  'superseded.md': '# Superseded\n- [I7 t1 retired t2] use yarn (reason: npm now)\n- [A9 t1 retired t2] x (reason: y)\n',
  'now.md': 'Goal: set up the project\n',
};

async function slate(files = BASE) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-apply-'));
  temps.push(root);
  const { dir } = await initSession(root, SID, 1);
  await writeMemory(dir, files);
  return { root, dir, before: await readMemory(dir) };
}

function assertSafe(r) {
  for (const t of [...r.applied, ...r.skipped, ...r.errors]) assert.match(t, SAFE_TOKEN, t);
}

// --- operations ---

test('add: next ID above every live or retired one of its type, tagged with turn and session', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'add', type: 'I', text: 'never force-push' },
    { op: 'add', type: 'A', text: 'deploys run nightly', home: 'general' },
    { op: 'add', type: 'F', text: 'port 8080 (config.yml)', home: 'general' },
  ], OPTS);
  assert.deepEqual(r, { applied: ['0:add I8', '1:add A10', '2:add F3'], skipped: [], errors: [], demoted: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], `${before['instructions.md']}- [I8 ${TAG}] never force-push\n`);
  assert.equal(now['assumptions.md'], `${before['assumptions.md']}- [A10 ${TAG}] deploys run nightly\n`);
  assert.equal(now['facts.md'], `${before['facts.md']}- [F3 ${TAG}] port 8080 (config.yml)\n`);
  assert.equal(now['superseded.md'], before['superseded.md']);
  assert.equal(now['now.md'], before['now.md']);
});

test('add: an ID of that type anywhere in the four shared files counts', async () => {
  const { dir } = await slate({
    ...BASE,
    'facts.md': '# Facts\n- [I12 t1] misplaced instruction\n',
    'assumptions.md': '# Assumptions\n- [I15 t1 retired t2] retired in the wrong file (reason: r)\n',
  });
  const r = await applyChanges(dir, [{ op: 'add', type: 'I', text: 'x' }], OPTS);
  assert.deepEqual(r.applied, ['0:add I16']);
});

test('add: a file without a trailing newline gets one before the new line', async () => {
  const { dir } = await slate({ ...BASE, 'facts.md': '# Facts\n- [F2 t1] Node 24 (package.json)' });
  await applyChanges(dir, [{ op: 'add', type: 'F', text: 'y (user)', home: 'general' }], OPTS);
  assert.equal((await readMemory(dir))['facts.md'], `# Facts\n- [F2 t1] Node 24 (package.json)\n- [F3 ${TAG}] y (user)\n`);
});

test('retire: the exact line moves to superseded.md with the retired tag and reason; old and new tags', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'retire', id: 'I1', reason: 'user switched to pnpm' },
    { op: 'retire', id: 'I2', reason: 'not needed' },
  ], OPTS);
  assert.deepEqual(r, { applied: ['0:retire I1', '1:retire I2'], skipped: [], errors: [], demoted: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], '# Instructions\n\n## Build\n\n## Style\n- [I4 t2] no semicolons\n');
  assert.equal(now['superseded.md'], `${before['superseded.md']}` +
    `- [I1 t1 retired ${TAG}] use npm (reason: user switched to pnpm)\n` +
    `- [I2 t3@0ther000 retired ${TAG}] run tests first (reason: not needed)\n`);
});

test('replace: retires the old item and adds the new text as a new item of the same type', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'replace', id: 'I1', text: 'use pnpm', reason: 'user switched' },
    { op: 'replace', id: 'F2', text: 'Node 24.1 (node --version)', reason: 'checked' },
  ], OPTS);
  assert.deepEqual(r, { applied: ['0:replace I1 I8', '1:replace F2 F3'], skipped: [], errors: [], demoted: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'],
    `# Instructions\n\n## Build\n- [I2 t3@0ther000] run tests first\n\n## Style\n- [I4 t2] no semicolons\n- [I8 ${TAG}] use pnpm\n`);
  assert.equal(now['facts.md'], `# Facts\n- [F3 ${TAG}] Node 24.1 (node --version)\n`);
  assert.equal(now['superseded.md'], `${before['superseded.md']}` +
    `- [I1 t1 retired ${TAG}] use npm (reason: user switched)\n` +
    `- [F2 t1 retired ${TAG}] Node 24 (package.json) (reason: checked)\n`);
});

test('now: rewrites only this session\'s now.md; shared files and other sessions stay byte-identical', async () => {
  const { dir, before } = await slate();
  const { dir: other } = await createSession(slateOf(dir), 'other', 2);
  await fs.writeFile(path.join(other, 'now.md'), 'Goal: other work\n');
  const r = await applyChanges(dir, [{ op: 'now', text: 'Goal: ship\n\nNext: run tests' }], OPTS);
  assert.deepEqual(r, { applied: ['0:now'], skipped: [], errors: [], demoted: [] });
  const now = await readMemory(dir);
  assert.equal(now['now.md'], 'Goal: ship\n\nNext: run tests\n');
  for (const f of ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md']) assert.equal(now[f], before[f], f);
  assert.equal(await fs.readFile(path.join(other, 'now.md'), 'utf8'), 'Goal: other work\n');
});

test('untouched lines keep their bytes: CRLF, odd spacing, headings', async () => {
  const instructions = '# Instructions\r\n## Keep  me \r\n- [I1 t1] use npm\r\n- [I2 t1]   spaced  text  \r\n';
  const { dir } = await slate({ ...BASE, 'instructions.md': instructions });
  await applyChanges(dir, [{ op: 'retire', id: 'I1', reason: 'r' }], OPTS);
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], '# Instructions\r\n## Keep  me \r\n- [I2 t1]   spaced  text  \r\n');
  assert.ok(now['superseded.md'].endsWith(`- [I1 t1 retired ${TAG}] use npm (reason: r)\n`));
});

// --- adoption and duplicates ---

test('plain user bullets are adopted at t0 with their text unchanged, even with no ops', async () => {
  const { dir } = await slate({
    ...BASE,
    'instructions.md': '# Instructions\n- [I1 t1] use npm\n- prefer tabs  \nfree text line\n* star bullet\n' +
      '- [I3] malformed tag\n- ~~use yarn~~ (retired I7)\n',
    'facts.md': '# Facts\r\n- repo is at /srv/app (user)\r\n',
  });
  const r = await applyChanges(dir, [], OPTS);
  assert.deepEqual(r, { applied: ['adopt I8', 'adopt F1'], skipped: [], errors: [], demoted: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], '# Instructions\n- [I1 t1] use npm\n- [I8 t0] prefer tabs  \nfree text line\n* star bullet\n' +
    '- [I3] malformed tag\n- ~~use yarn~~ (retired I7)\n');
  assert.equal(now['facts.md'], '# Facts\r\n- [F1 t0] repo is at /srv/app (user)\r\n');
});

test('an add whose text matches a live item exactly is skipped, adopted bullets and same-list adds included', async () => {
  const { dir, before } = await slate({ ...BASE, 'assumptions.md': '# Assumptions\n- prefer tabs\n' });
  const r = await applyChanges(dir, [
    { op: 'add', type: 'I', text: 'use npm' },
    { op: 'add', type: 'A', text: 'prefer tabs', home: 'general' },
    { op: 'add', type: 'I', text: 'new rule' },
    { op: 'add', type: 'I', text: 'new rule' },
    { op: 'add', type: 'I', text: 'use yarn' }, // retired, not live: added again
  ], OPTS);
  assert.deepEqual(r, {
    applied: ['adopt A10', '2:add I8', '4:add I9'],
    skipped: ['0:duplicate I1', '1:duplicate A10', '3:duplicate I8'],
    errors: [],
    demoted: [],
  });
  assert.equal((await readMemory(dir))['instructions.md'],
    `${before['instructions.md']}- [I8 ${TAG}] new rule\n- [I9 ${TAG}] use yarn\n`);
});

// --- strict and lenient ---

test('strict: one stale ID means nothing is applied, adoption included', async () => {
  const { dir, before } = await slate({ ...BASE, 'instructions.md': `${BASE['instructions.md']}- prefer tabs\n` });
  const r = await applyChanges(dir, [
    { op: 'add', type: 'I', text: 'fine' },
    { op: 'retire', id: 'I7', reason: 'already retired' },
    { op: 'replace', id: 'F9', text: 'x (user)', reason: 'never existed' },
  ], OPTS);
  assert.deepEqual(r, { applied: [], skipped: [], errors: ['1:stale I7', '2:stale F9'], demoted: [] });
  assert.deepEqual(await readMemory(dir), before);
});

test('strict: an ID retired earlier in the same list is stale for a later op', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'retire', id: 'I1', reason: 'r' },
    { op: 'replace', id: 'I1', text: 'use pnpm', reason: 'r' },
  ], OPTS);
  assert.deepEqual(r.errors, ['1:stale I1']);
  assert.deepEqual(await readMemory(dir), before);
});

test('lenient: a stale replace still adds its new item; a stale retire is dropped', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'replace', id: 'I5', text: 'use pnpm', reason: 'user switched' },
    { op: 'retire', id: 'A3', reason: 'r' },
    { op: 'add', type: 'A', text: 'fine', home: 'general' },
  ], { ...OPTS, lenient: true });
  assert.deepEqual(r, {
    applied: ['0:add I8', '2:add A10'], skipped: [], errors: ['0:stale I5', '1:stale A3'], demoted: [],
  });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], `${before['instructions.md']}- [I8 ${TAG}] use pnpm\n`);
  assert.equal(now['superseded.md'], before['superseded.md']);
});

const ROOT_SLATE = '<slate>';
const INVALID = [
  ['unknown op', { op: 'delete', id: 'I1' }, 'bad op'],
  ['not an object', null, 'bad op'],
  ['unknown type', { op: 'add', type: 'X', text: 'x' }, 'bad op'],
  ['missing text', { op: 'add', type: 'I' }, 'bad op'],
  ['ID of another kind', { op: 'retire', id: 'X1', reason: 'r' }, 'bad id'],
  ['ID with text', { op: 'retire', id: 'I1 use npm', reason: 'r' }, 'bad id'],
  ['lowercase ID', { op: 'replace', id: 'i1', text: 'x', reason: 'r' }, 'bad id'],
  ['empty text', { op: 'add', type: 'I', text: '  ' }, 'empty text'],
  ['multi-line text', { op: 'add', type: 'I', text: 'a\nb' }, 'multi-line text'],
  ['carriage return in text', { op: 'replace', id: 'I1', text: 'a\rb', reason: 'r' }, 'multi-line text'],
  ['retired tag in text', { op: 'add', type: 'I', text: 'x [I3 t1 retired t2] y' }, 'tag in text'],
  ['free-form retired note', { op: 'add', type: 'I', text: '~~use yarn~~ (retired I7)' }, 'tag in text'],
  ['item tag in text', { op: 'add', type: 'I', text: '[I3 t2@82b3114c] use npm' }, 'tag in text'],
  ['fact without a source', { op: 'add', type: 'F', text: 'port is 8080' }, 'no source'],
  ['fact with an empty source', { op: 'add', type: 'F', text: 'port is 8080 ( )' }, 'no source'],
  ['fact citing a report', { op: 'add', type: 'F', text: 'x (see /tmp/s/topic/reports/a.md)' }, 'report source'],
  ['fact citing reports/', { op: 'add', type: 'F', text: 'x (reports/a.md)' }, 'report source'],
  ['fact citing .slate', { op: 'replace', id: 'F2', text: 'x (.slate/abc/now.md)', reason: 'r' }, 'report source'],
  ['fact citing the slate path', { op: 'add', type: 'F', text: `x (${ROOT_SLATE}/facts.md)` }, 'report source'],
  ['empty reason', { op: 'retire', id: 'I1', reason: ' ' }, 'empty reason'],
  ['empty replace reason', { op: 'replace', id: 'I1', text: 'x', reason: '' }, 'empty reason'],
  ['multi-line reason', { op: 'retire', id: 'I1', reason: 'a\nb' }, 'multi-line reason'],
  ['now over 10 lines', { op: 'now', text: Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n') }, 'now too long'],
  ['item tag in now', { op: 'now', text: 'Goal: x\n- [I1 t1] use npm' }, 'tag in now'],
  ['retired note in now', { op: 'now', text: 'Goal: x (retired I1)' }, 'tag in now'],
  // topics, homes and moves
  ['topic with a bad slug', { op: 'topic', slug: 'Canonical URLs', title: 'T', summary: 'S' }, 'bad slug'],
  ['topic named key', { op: 'topic', slug: 'key', title: 'T', summary: 'S' }, 'bad slug'],
  ['add into a bad slug', { op: 'add', type: 'F', text: 'x (user)', topic: '../x' }, 'bad slug'],
  ['home with a bad slug', { op: 'add', type: 'A', text: 'x', home: 'a b' }, 'bad slug'],
  ['move to a bad slug', { op: 'move', id: 'F2', to: 'x/y' }, 'bad slug'],
  ['topic without a summary', { op: 'topic', slug: 'seo', title: 'SEO' }, 'bad op'],
  ['topic with an empty title', { op: 'topic', slug: 'seo', title: ' ', summary: 'S' }, 'empty title'],
  ['topic with an empty summary', { op: 'topic', slug: 'seo', title: 'SEO', summary: '' }, 'empty summary'],
  ['topic with a multi-line title', { op: 'topic', slug: 'seo', title: 'a\nb', summary: 'S' }, 'multi-line title'],
  ['topic with a multi-line summary', { op: 'topic', slug: 'seo', title: 'SEO', summary: 'a\r\nb' }, 'multi-line summary'],
  ['add into a missing topic', { op: 'add', type: 'F', text: 'x (user)', topic: 'nope' }, 'missing topic'],
  ['key fact without a home', { op: 'add', type: 'F', text: 'x (user)' }, 'no home'],
  ['key assumption without a home', { op: 'add', type: 'A', text: 'x' }, 'no home'],
  ['home naming a missing topic', { op: 'add', type: 'F', text: 'x (user)', home: 'nope' }, 'missing topic'],
  ['move to a missing topic', { op: 'move', id: 'F2', to: 'nope' }, 'missing topic'],
  ['move of an instruction', { op: 'move', id: 'I1', to: 'general' }, 'instruction move'],
  ['move with a bad ID', { op: 'move', id: 'F', to: 'key' }, 'bad id'],
  ['move of a missing item', { op: 'move', id: 'F9', to: 'key' }, 'stale F9'],
  ['instruction into a topic', { op: 'add', type: 'I', text: 'x', topic: 'general' }, 'bad op'],
  ['add with both topic and home', { op: 'add', type: 'F', text: 'x (user)', topic: 'general', home: 'general' }, 'bad op'],
];

for (const [name, op, kind] of INVALID) {
  test(`invalid: ${name} → ${kind}; strict applies nothing, lenient drops only that op`, async () => {
    const { dir, before } = await slate();
    const fix = (o) => (o && typeof o.text === 'string' ? { ...o, text: o.text.replace(ROOT_SLATE, slateOf(dir)) } : o);
    const ops = [{ op: 'add', type: 'I', text: 'valid rule' }, fix(op)];
    const strict = await applyChanges(dir, ops, OPTS);
    assert.deepEqual(strict, { applied: [], skipped: [], errors: [`1:${kind}`], demoted: [] });
    assertSafe(strict);
    assert.deepEqual(await readMemory(dir), before);

    const lenient = await applyChanges(dir, ops, { ...OPTS, lenient: true });
    assert.deepEqual(lenient, { applied: ['0:add I8'], skipped: [], errors: [`1:${kind}`], demoted: [] });
    const now = await readMemory(dir);
    assert.equal(now['instructions.md'], `${before['instructions.md']}- [I8 ${TAG}] valid rule\n`);
    for (const f of ['assumptions.md', 'facts.md', 'superseded.md', 'now.md']) assert.equal(now[f], before[f], f);
    for (const f of ['topics', 'usage.json']) assert.equal(await exists(path.join(slateOf(dir), f)), false, f);
  });
}

test('a fact citing the slate by its real path is refused too', async () => {
  const { dir } = await slate();
  const real = realpathSync(slateOf(dir));
  if (process.platform === 'darwin') assert.notEqual(real, slateOf(dir), 'tmpdir goes through a symlink on macOS');
  const r = await applyChanges(dir, [{ op: 'add', type: 'F', text: `x (${real}/facts.md)` }], OPTS);
  assert.deepEqual(r.errors, ['0:report source']);
});

test('valid edge cases: 10 lines of now with blanks, a nested source, an empty now', async () => {
  const { dir } = await slate();
  const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n\n');
  const r = await applyChanges(dir, [
    { op: 'now', text: ten },
    { op: 'add', type: 'F', text: 'tests pass (npm test (v2))', home: 'general' },
  ], OPTS);
  assert.deepEqual(r.errors, []);
  assert.equal((await readMemory(dir))['now.md'], `${ten}\n`);
  await applyChanges(dir, [{ op: 'now', text: '' }], OPTS);
  assert.equal((await readMemory(dir))['now.md'], '');
});

test('CHANGE_SCHEMA: ops is a list of closed op shapes plus relevant IDs; add has no id', () => {
  assert.deepEqual(CHANGE_SCHEMA.required, ['ops', 'relevant']);
  assert.equal(CHANGE_SCHEMA.additionalProperties, false);
  assert.deepEqual(CHANGE_SCHEMA.properties.relevant, { type: 'array', items: { type: 'string' } });
  const shapes = CHANGE_SCHEMA.properties.ops.items.oneOf;
  const key = (s) => [s.properties.op.const, ...Object.keys(s.properties).filter((k) => k !== 'op').sort()].join(' ');
  const fields = {
    add: [['type', 'text'], ['type', 'text', 'topic'], ['type', 'text', 'home']],
    retire: [['id', 'reason']],
    replace: [['id', 'text', 'reason']],
    now: [['text']],
    topic: [['slug', 'title', 'summary']],
    move: [['id', 'to']],
  };
  const want = Object.entries(fields).flatMap(([op, sets]) => sets.map((f) => [op, ...[...f].sort()].join(' ')));
  assert.deepEqual(shapes.map(key).sort(), want.sort());
  for (const s of shapes) {
    assert.equal(s.additionalProperties, false, key(s));
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), key(s));
  }
  const adds = shapes.filter((s) => s.properties.op.const === 'add');
  // An instruction never goes in a topic; a fact or assumption is added to a topic or with a home.
  assert.deepEqual(adds.find((s) => !s.properties.topic && !s.properties.home).properties.type.enum, ['I']);
  for (const s of adds.filter((x) => x.properties.topic || x.properties.home)) {
    assert.deepEqual(s.properties.type.enum, ['A', 'F'], key(s));
  }
});

// --- memory.lock ---

// A child process that runs `code` with argv [module URL, ...args].
function child(code, args, stdio = ['ignore', 'pipe', 'pipe']) {
  return spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio });
}

const ADD_MANY = `
const [mod, dir, sid, tag, start, count] = process.argv.slice(1);
const { applyChanges } = await import(mod);
await new Promise((r) => setTimeout(r, Math.max(0, Number(start) - Date.now())));
for (let i = 1; i <= Number(count); i++) {
  const r = await applyChanges(dir, [{ op: 'add', type: 'I', text: tag + ' ' + i }], { turn: i, sessionId: sid });
  if (r.applied.length !== 1) throw new Error(JSON.stringify(r));
}
`;

test('Review Focus 2: six processes applying 30 adds each at once lose nothing and share no ID', async () => {
  const PROCS = 6;
  const ADDS = 30;
  const { dir } = await slate({ 'instructions.md': '# Instructions\n', 'superseded.md': '# Superseded\n' });
  const sessions = [{ dir, sid: SID }];
  for (let p = 1; p < PROCS; p++) {
    const sid = `${p}${'b'.repeat(7)}-other`;
    sessions.push({ dir: (await createSession(slateOf(dir), sid, 2)).dir, sid });
  }
  const start = String(Date.now() + 500);
  const kids = sessions.map(({ dir: d, sid }, p) =>
    child(ADD_MANY, [APPLY, d, sid, `from ${p}`, start, String(ADDS)], ['ignore', 'ignore', 'inherit']));
  const codes = await Promise.all(kids.map(async (k) => (await once(k, 'exit'))[0]));
  assert.deepEqual(codes, Array(PROCS).fill(0));

  const lines = (await readMemory(dir))['instructions.md'].split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, PROCS * ADDS);
  const ids = lines.map((l) => /^- \[(I\d+) /.exec(l)[1]);
  assert.equal(new Set(ids).size, PROCS * ADDS, 'unique IDs');
  assert.deepEqual(ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b),
    Array.from({ length: PROCS * ADDS }, (_, i) => i + 1));
  const texts = new Set(lines.map((l) => l.replace(/^- \[[^\]]*\] /, '')));
  for (let p = 0; p < PROCS; p++) for (let i = 1; i <= ADDS; i++) assert.ok(texts.has(`from ${p} ${i}`), `from ${p} ${i}`);
  for (const { sid } of sessions) assert.ok(lines.some((l) => l.includes(`@${sid.slice(0, 8)}]`)), sid);
  const left = (await fs.readdir(slateOf(dir))).filter((n) => n.includes('.lock') || n.endsWith('.tmp'));
  assert.deepEqual(left, [], 'no lock, claim or temp file left behind');
});

const HOLD = `
const [mod, slate] = process.argv.slice(1);
const { acquire } = await import(mod);
process.stdout.write((await acquire(slate, 'memory.lock')) ? 'held\\n' : 'busy\\n');
setInterval(() => {}, 1000);
`;

test('Review Focus 2: a memory.lock left by a killed holder is taken over at once', async () => {
  const { dir } = await slate();
  const holder = child(HOLD, [LOCK, slateOf(dir)]);
  const [first] = await once(holder.stdout, 'data');
  assert.equal(String(first), 'held\n');
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  const lock = path.join(slateOf(dir), 'memory.lock');
  assert.equal(Number.parseInt(await fs.readFile(lock, 'utf8'), 10), holder.pid, 'the dead holder left its lock');

  const t0 = Date.now();
  const r = await applyChanges(dir, [{ op: 'add', type: 'I', text: 'after the crash' }], OPTS);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  assert.deepEqual(r.applied, ['0:add I8']);
  assert.equal(await exists(lock), false, 'released');
});

test('a live memory.lock holder makes applyChanges wait, then it proceeds', async () => {
  const { dir } = await slate();
  const release = await acquire(slateOf(dir), 'memory.lock');
  setTimeout(release, 300);
  const t0 = Date.now();
  const r = await applyChanges(dir, [{ op: 'add', type: 'I', text: 'waited' }], OPTS);
  assert.ok(Date.now() - t0 >= 250, `took ${Date.now() - t0}ms`);
  assert.deepEqual(r.applied, ['0:add I8']);
  assert.equal(await exists(path.join(slateOf(dir), 'memory.lock')), false);
});

test('a deleted slate: applyChanges throws and recreates nothing', async () => {
  const { dir } = await slate();
  const s = slateOf(dir);
  await fs.rm(s, { recursive: true });
  await assert.rejects(applyChanges(dir, [
    { op: 'add', type: 'I', text: 'x' }, { op: 'now', text: 'Goal: x' },
  ], OPTS));
  assert.equal(await exists(s), false);
});

// --- topics, relevance and caps ---

const T1 = new Date('2026-10-20T10:00:00.000Z');
const T2 = new Date('2026-10-21T10:00:00.000Z');
const T3 = new Date('2026-10-22T10:00:00.000Z');
const topicFile = (dir, slug) => path.join(slateOf(dir), 'topics', `${slug}.md`);
const readTopic = (dir, slug) => fs.readFile(topicFile(dir, slug), 'utf8');
async function writeTopic(dir, slug, text) {
  await fs.mkdir(path.join(slateOf(dir), 'topics'), { recursive: true });
  await fs.writeFile(topicFile(dir, slug), text);
}
const usagePath = (dir) => path.join(slateOf(dir), 'usage.json');
const readUsage = async (dir) => JSON.parse(await fs.readFile(usagePath(dir), 'utf8'));
const writeUsage = (dir, usage) => fs.writeFile(usagePath(dir), JSON.stringify(usage));
const use = (date, count, home) => ({ last: date.toISOString(), count, ...(home && { home }) });
// An item line of exactly n chars, its text unique to its ID.
function itemLine(id, n) {
  const head = `- [${id} t1] ${id} `;
  return `${head}${'x'.repeat(n - head.length - ' (user)'.length)} (user)`;
}
const BUILD = '# Build\n> How the project builds.\n';

test('topic: creates topics/<slug>.md with its title and summary; another updates only the header', async () => {
  const { dir, before } = await slate();
  let r = await applyChanges(dir, [{ op: 'topic', slug: 'canonical', title: 'Canonical URLs', summary: 'Which URL wins.' }], OPTS);
  assert.deepEqual(r, { applied: ['0:topic canonical'], skipped: [], errors: [], demoted: [] });
  assert.equal(await readTopic(dir, 'canonical'), '# Canonical URLs\n> Which URL wins.\n');
  await fs.appendFile(topicFile(dir, 'canonical'), '- [F5 t1]  kept  as is (user)\n');
  r = await applyChanges(dir, [{ op: 'topic', slug: 'canonical', title: ' Canonical ', summary: 'Rules for canonical tags.' }], OPTS);
  assert.deepEqual(r.applied, ['0:topic canonical']);
  assert.equal(await readTopic(dir, 'canonical'), '# Canonical\n> Rules for canonical tags.\n- [F5 t1]  kept  as is (user)\n');
  assert.deepEqual(await readMemory(dir), before);
});

test('topic ops apply first: an add earlier in the list can go into a topic the list creates', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'add', type: 'F', text: 'one canonical tag per page (user)', topic: 'canonical' },
    { op: 'add', type: 'A', text: 'themes print their own tag', topic: 'canonical' },
    { op: 'topic', slug: 'canonical', title: 'Canonical URLs', summary: 'Which URL wins.' },
  ], { ...OPTS, now: T1 });
  assert.deepEqual(r, {
    applied: ['2:topic canonical', '0:add F3>canonical', '1:add A10>canonical'], skipped: [], errors: [], demoted: [],
  });
  assert.equal(await readTopic(dir, 'canonical'), '# Canonical URLs\n> Which URL wins.\n' +
    `- [F3 ${TAG}] one canonical tag per page (user)\n- [A10 ${TAG}] themes print their own tag\n`);
  assert.deepEqual(await readMemory(dir), before, 'key files untouched');
  assert.deepEqual(await readUsage(dir), { A10: use(T1, 0), F3: use(T1, 0) }, 'added items are stamped');
});

test('a key add lands in its key file and records its home in usage.json', async () => {
  const { dir, before } = await slate();
  await writeTopic(dir, 'build', BUILD);
  const r = await applyChanges(dir, [{ op: 'add', type: 'F', text: 'pnpm 9 (package.json)', home: 'build' }], { ...OPTS, now: T1 });
  assert.deepEqual(r.applied, ['0:add F3']);
  assert.equal((await readMemory(dir))['facts.md'], `${before['facts.md']}- [F3 ${TAG}] pnpm 9 (package.json)\n`);
  assert.equal(await readTopic(dir, 'build'), BUILD);
  assert.deepEqual(await readUsage(dir), { F3: use(T1, 0, 'build') });
});

test('general: a home before it exists; created with its title and summary when an item lands in it', async () => {
  const { dir } = await slate();
  await applyChanges(dir, [{ op: 'add', type: 'A', text: 'deploys run nightly', home: 'general' }], OPTS);
  assert.equal(await exists(path.join(slateOf(dir), 'topics')), false, 'no topic needed yet');
  const r = await applyChanges(dir, [{ op: 'move', id: 'A10', to: 'general' }], OPTS);
  assert.deepEqual(r.applied, ['0:move A10>general']);
  assert.equal(await readTopic(dir, 'general'),
    `# General\n> Items without a more specific topic.\n- [A10 ${TAG}] deploys run nightly\n`);
});

test('move: key to topic and topic to key keep the line byte-identical; a promoted item is stamped with its home', async () => {
  const facts = '# Facts\n- [F2 t1] Node 24 (package.json)\n- [F3 t4@0ther000]  odd  spacing (user)\n';
  const { dir } = await slate({ ...BASE, 'facts.md': facts });
  await writeTopic(dir, 'build', `${BUILD}- [F6 t2@0ther000] uses vite (vite.config.ts)\n`);
  const r = await applyChanges(dir, [
    { op: 'move', id: 'F3', to: 'build' },
    { op: 'move', id: 'F6', to: 'key' },
  ], { ...OPTS, now: T1 });
  assert.deepEqual(r, { applied: ['0:move F3>build', '1:move F6>key'], skipped: [], errors: [], demoted: [] });
  assert.equal((await readMemory(dir))['facts.md'],
    '# Facts\n- [F2 t1] Node 24 (package.json)\n- [F6 t2@0ther000] uses vite (vite.config.ts)\n');
  assert.equal(await readTopic(dir, 'build'), `${BUILD}- [F3 t4@0ther000]  odd  spacing (user)\n`);
  assert.deepEqual(await readUsage(dir), { F6: use(T1, 0, 'build') });

  const again = await applyChanges(dir, [{ op: 'move', id: 'F6', to: 'key' }, { op: 'move', id: 'F3', to: 'build' }], OPTS);
  assert.deepEqual(again, { applied: [], skipped: ['0:in place F6', '1:in place F3'], errors: [], demoted: [] });
});

test('retire and replace reach topic items; a replacement stays in its topic; the next ID counts topic files', async () => {
  const { dir, before } = await slate();
  await writeTopic(dir, 'build', `${BUILD}- [F20 t1] uses vite (vite.config.ts)\n- [A30 t1] CI caches deps\n`);
  const r = await applyChanges(dir, [
    { op: 'replace', id: 'F20', text: 'uses vite 6 (vite.config.ts)', reason: 'upgraded' },
    { op: 'retire', id: 'A30', reason: 'checked: it does not' },
    { op: 'add', type: 'A', text: 'deploys run nightly', home: 'build' },
  ], OPTS);
  assert.deepEqual(r.applied, ['0:replace F20 F21', '1:retire A30', '2:add A31']);
  assert.equal(await readTopic(dir, 'build'), `${BUILD}- [F21 ${TAG}] uses vite 6 (vite.config.ts)\n`);
  assert.equal((await readMemory(dir))['superseded.md'], `${before['superseded.md']}` +
    `- [F20 t1 retired ${TAG}] uses vite (vite.config.ts) (reason: upgraded)\n` +
    `- [A30 t1 retired ${TAG}] CI caches deps (reason: checked: it does not)\n`);
});

test('an add whose text is live in a topic is a duplicate', async () => {
  const { dir } = await slate();
  await writeTopic(dir, 'build', `${BUILD}- [F20 t1] uses vite (vite.config.ts)\n`);
  const r = await applyChanges(dir, [{ op: 'add', type: 'F', text: 'uses vite (vite.config.ts)', home: 'build' }], OPTS);
  assert.deepEqual(r.skipped, ['0:duplicate F20']);
});

test('a plain bullet in a topic file is adopted as a fact at t0, text unchanged', async () => {
  const { dir } = await slate();
  await writeTopic(dir, 'build', `${BUILD}- uses vite (user)\n`);
  const r = await applyChanges(dir, [], OPTS);
  assert.deepEqual(r.applied, ['adopt F3']);
  assert.equal(await readTopic(dir, 'build'), `${BUILD}- [F3 t0] uses vite (user)\n`);
});

test('relevant: live facts and assumptions get last and count; unknown, retired, instruction and malformed IDs are ignored', async () => {
  const { dir } = await slate();
  await writeTopic(dir, 'build', `${BUILD}- [F20 t1] uses vite (vite.config.ts)\n`);
  await applyChanges(dir, [], { ...OPTS, relevant: ['F2', 'F20', 'A1', 'F2'], now: T1 });
  assert.deepEqual(await readUsage(dir), { A1: use(T1, 1), F2: use(T1, 1), F20: use(T1, 1) });
  await applyChanges(dir, [], { ...OPTS, relevant: ['F2', 'F99', 'A9', 'I1', 'F 2', 7], now: T2 });
  assert.deepEqual(await readUsage(dir), { A1: use(T1, 1), F2: use(T2, 2), F20: use(T1, 1) });
});

test('strict: an error writes no usage either', async () => {
  const { dir } = await slate();
  const r = await applyChanges(dir, [{ op: 'retire', id: 'F9', reason: 'r' }], { ...OPTS, relevant: ['F2'] });
  assert.deepEqual(r.errors, ['0:stale F9']);
  assert.equal(await exists(usagePath(dir)), false);
});

test('usage.json drops the entry of an item that is no longer live', async () => {
  const { dir } = await slate();
  await applyChanges(dir, [], { ...OPTS, relevant: ['F2', 'A1'], now: T1 });
  await applyChanges(dir, [{ op: 'retire', id: 'F2', reason: 'gone' }], OPTS);
  assert.deepEqual(await readUsage(dir), { A1: use(T1, 1) });
});

test('caps: 3,000 chars of fact lines and 1,500 of assumption lines', () => {
  assert.equal(FACTS_CAP, 3000);
  assert.equal(ASSUMPTIONS_CAP, 1500);
});

test('caps: going past 3,000 demotes the least recently relevant key fact to its home, line unchanged', async () => {
  const lines = [itemLine('F1', 1000), itemLine('F2', 1000), itemLine('F3', 900)];
  const { dir } = await slate({ ...BASE, 'facts.md': `# Facts\n${lines.join('\n')}\n` });
  await writeTopic(dir, 'build', BUILD);
  await writeTopic(dir, 'seo', '# SEO\n> Search.\n');
  await writeUsage(dir, { F1: use(T2, 1, 'build'), F2: use(T1, 9, 'seo'), F3: use(T3, 1, 'build') });
  const r = await applyChanges(dir, [{ op: 'add', type: 'F', text: `${'n'.repeat(200)} (user)`, home: 'build' }], { ...OPTS, now: T3 });
  assert.deepEqual(r, { applied: ['0:add F4'], skipped: [], errors: [], demoted: ['F2>seo'] });
  assert.equal((await readMemory(dir))['facts.md'],
    `# Facts\n${lines[0]}\n${lines[2]}\n- [F4 ${TAG}] ${'n'.repeat(200)} (user)\n`);
  assert.equal(await readTopic(dir, 'seo'), `# SEO\n> Search.\n${lines[1]}\n`);
  assert.equal(await readTopic(dir, 'build'), BUILD);
  assert.deepEqual((await readUsage(dir)).F2, use(T1, 9, 'seo'), 'a demoted item keeps its usage');
});

test('caps: on a tie the lower count goes, then the lower ID', async () => {
  const lines = [itemLine('F1', 1000), itemLine('F2', 1000), itemLine('F3', 900)];
  const { dir } = await slate({ ...BASE, 'facts.md': `# Facts\n${lines.join('\n')}\n` });
  await writeTopic(dir, 'build', BUILD);
  await writeUsage(dir, { F1: use(T1, 3, 'build'), F2: use(T1, 1, 'build'), F3: use(T1, 1, 'build') });
  const r = await applyChanges(dir, [{ op: 'add', type: 'F', text: `${'n'.repeat(200)} (user)`, home: 'build' }], OPTS);
  assert.deepEqual(r.demoted, ['F2>build']);
  assert.equal(await readTopic(dir, 'build'), `${BUILD}${lines[1]}\n`);
});

test('caps: an item with no usage counts as oldest; with no home it goes to general, which is created', async () => {
  const lines = [itemLine('F1', 1500), itemLine('F2', 1400)];
  const { dir } = await slate({ ...BASE, 'facts.md': `# Facts\n${lines.join('\n')}\n` });
  await writeUsage(dir, { F1: use(T1, 1) });
  const r = await applyChanges(dir, [{ op: 'add', type: 'F', text: `${'n'.repeat(200)} (user)`, home: 'general' }], OPTS);
  assert.deepEqual(r.demoted, ['F2>general']);
  assert.equal(await readTopic(dir, 'general'), `# General\n> Items without a more specific topic.\n${lines[1]}\n`);
});

test('caps: items added or promoted by the same list are never demoted, even if the file stays over', async () => {
  const { dir } = await slate({ ...BASE, 'facts.md': `# Facts\n${itemLine('F1', 1000)}\n` });
  await writeTopic(dir, 'build', `${BUILD}${itemLine('F9', 1500)}\n`);
  const r = await applyChanges(dir, [
    { op: 'move', id: 'F9', to: 'key' },
    { op: 'add', type: 'F', text: `${'n'.repeat(1500)} (user)`, home: 'build' },
  ], OPTS);
  assert.deepEqual(r, { applied: ['0:move F9>key', '1:add F10'], skipped: [], errors: [], demoted: ['F1>general'] });
  const facts = (await readMemory(dir))['facts.md'];
  assert.ok(facts.includes(itemLine('F9', 1500)) && facts.includes('- [F10 '), facts.slice(0, 80));
  assert.ok(facts.length > FACTS_CAP, 'still over: demotion never fails the apply');
});

test('caps: assumptions.md obeys 1,500 chars', async () => {
  const lines = [itemLine('A1', 800), itemLine('A2', 600)];
  const { dir } = await slate({ ...BASE, 'assumptions.md': `# Assumptions\n${lines.join('\n')}\n` });
  await writeUsage(dir, { A2: use(T1, 1) });
  const r = await applyChanges(dir, [{ op: 'add', type: 'A', text: 'n'.repeat(200), home: 'general' }], OPTS);
  assert.deepEqual(r.demoted, ['A1>general']);
  assert.equal((await readMemory(dir))['assumptions.md'], `# Assumptions\n${lines[1]}\n- [A10 ${TAG}] ${'n'.repeat(200)}\n`);
  assert.equal(await readTopic(dir, 'general'), `# General\n> Items without a more specific topic.\n${lines[0]}\n`);
});

test('caps: a bullet adopted by this apply is stamped and not demoted; a later apply demotes it by recency', async () => {
  const T4 = new Date('2026-10-23T10:00:00.000Z');
  const bullet = `${'u'.repeat(883)} (user)`; // adopted as `- [F3 t0] …`, 900 chars
  const lines = [itemLine('F1', 1000), itemLine('F2', 1000)];
  const { dir } = await slate({ ...BASE, 'facts.md': `# Facts\n${lines.join('\n')}\n- ${bullet}\n` });
  await writeUsage(dir, { F1: use(T1, 1), F2: use(T2, 1) });
  let r = await applyChanges(dir, [{ op: 'add', type: 'F', text: `${'n'.repeat(200)} (user)`, home: 'general' }], { ...OPTS, now: T3 });
  assert.deepEqual(r, { applied: ['adopt F3', '0:add F4'], skipped: [], errors: [], demoted: ['F1>general'] });
  assert.equal((await readMemory(dir))['facts.md'],
    `# Facts\n${lines[1]}\n- [F3 t0] ${bullet}\n- [F4 ${TAG}] ${'n'.repeat(200)} (user)\n`);
  assert.deepEqual((await readUsage(dir)).F3, use(T3, 0), 'an adopted item is stamped like an add');

  r = await applyChanges(dir, [{ op: 'add', type: 'F', text: `${'m'.repeat(1000)} (user)`, home: 'general' }],
    { ...OPTS, relevant: ['F2', 'F4'], now: T4 });
  assert.deepEqual(r.demoted, ['F3>general'], 'now the least recently relevant');
  assert.ok((await readTopic(dir, 'general')).endsWith(`- [F3 t0] ${bullet}\n`));
});

test('caps: only item lines count; a key file at the cap is left alone', async () => {
  const facts = `# Facts\n\n## Notes\nfree text ${'z'.repeat(500)}\n${itemLine('F1', 1500)}\n${itemLine('F2', 1500)}\n`;
  const { dir } = await slate({ ...BASE, 'facts.md': facts });
  const r = await applyChanges(dir, [], OPTS);
  assert.deepEqual(r.demoted, []);
  assert.equal((await readMemory(dir))['facts.md'], facts);
});

const ADD_TOPICS = `
const [mod, dir, sid, tag, start, count] = process.argv.slice(1);
const { applyChanges } = await import(mod);
await new Promise((r) => setTimeout(r, Math.max(0, Number(start) - Date.now())));
for (let i = 1; i <= Number(count); i++) {
  const text = tag + ' ' + i + ' ' + 'p'.repeat(40);
  const op = i % 3 === 0 ? { op: 'add', type: 'I', text }
    : i % 3 === 1 ? { op: 'add', type: 'F', text: text + ' (user)', topic: 'shared' }
    : { op: 'add', type: 'F', text: text + ' (user)', home: 'shared' };
  const r = await applyChanges(dir, [op], { turn: i, sessionId: sid, relevant: ['F1'] });
  if (r.applied.length !== 1 || r.errors.length) throw new Error(JSON.stringify(r));
}
`;

test('Review Focus 2: six processes adding to key files and topics with relevant lose nothing and share no ID', async () => {
  const PROCS = 6;
  const ADDS = 30;
  const { dir } = await slate({
    'instructions.md': '# Instructions\n', 'facts.md': '# Facts\n- [F1 t1] the seed (user)\n', 'superseded.md': '# Superseded\n',
  });
  await writeTopic(dir, 'shared', '# Shared\n> Everything.\n');
  const sessions = [{ dir, sid: SID }];
  for (let p = 1; p < PROCS; p++) {
    const sid = `${p}${'b'.repeat(7)}-other`;
    sessions.push({ dir: (await createSession(slateOf(dir), sid, 2)).dir, sid });
  }
  const start = String(Date.now() + 500);
  const kids = sessions.map(({ dir: d, sid }, p) =>
    child(ADD_TOPICS, [APPLY, d, sid, `from ${p}`, start, String(ADDS)], ['ignore', 'ignore', 'inherit']));
  const codes = await Promise.all(kids.map(async (k) => (await once(k, 'exit'))[0]));
  assert.deepEqual(codes, Array(PROCS).fill(0));

  const mem = await readMemory(dir);
  const topics = path.join(slateOf(dir), 'topics');
  const texts = [mem['instructions.md'], mem['facts.md']];
  for (const f of await fs.readdir(topics)) texts.push(await fs.readFile(path.join(topics, f), 'utf8'));
  const lines = texts.join('\n').split('\n').filter((l) => /^- \[[IAF]\d+ /.test(l));
  assert.equal(lines.length, PROCS * ADDS + 1);
  const ids = lines.map((l) => /^- \[([IAF]\d+) /.exec(l)[1]);
  assert.equal(new Set(ids).size, ids.length, 'unique IDs');
  const nums = (type) => ids.filter((id) => id[0] === type).map((id) => Number(id.slice(1))).sort((a, b) => a - b);
  assert.deepEqual(nums('I'), Array.from({ length: PROCS * ADDS / 3 }, (_, i) => i + 1));
  assert.deepEqual(nums('F'), Array.from({ length: (PROCS * ADDS * 2) / 3 + 1 }, (_, i) => i + 1));
  const all = new Set(lines.map((l) => l.replace(/^- \[[^\]]*\] /, '').replace(/ \(user\)$/, '')));
  for (let p = 0; p < PROCS; p++) {
    for (let i = 1; i <= ADDS; i++) assert.ok(all.has(`from ${p} ${i} ${'p'.repeat(40)}`), `from ${p} ${i}`);
  }
  assert.equal((await readUsage(dir)).F1.count, PROCS * ADDS, 'no relevance update lost');
  const keyChars = mem['facts.md'].split('\n').filter((l) => l.startsWith('- [')).reduce((n, l) => n + l.length, 0);
  assert.ok(keyChars <= FACTS_CAP, `facts.md holds ${keyChars} chars of items`);
  for (const d of [slateOf(dir), topics]) {
    const left = (await fs.readdir(d)).filter((n) => n.includes('.lock') || n.endsWith('.tmp'));
    assert.deepEqual(left, [], `no lock, claim or temp file left in ${d}`);
  }
});

// --- reorganize mode ---

const REORG = { turn: 0, sessionId: 'reorg', reorganize: true };

test('reorganize: dir is the slate folder; only topic, move and retire apply, any other op is "op not allowed"', async () => {
  const { dir, before } = await slate();
  const ops = [
    { op: 'add', type: 'I', text: 'never force-push' },
    { op: 'replace', id: 'F2', text: 'Node 26 (package.json)', reason: 'upgraded' },
    { op: 'now', text: 'Goal: something else' },
    { op: 'topic', slug: 'build', title: 'Build', summary: 'How it builds.' },
    { op: 'move', id: 'F2', to: 'build' },
    { op: 'frobnicate' },
  ];
  const errors = ['0:op not allowed', '1:op not allowed', '2:op not allowed', '5:op not allowed'];
  const strict = await applyChanges(slateOf(dir), ops, REORG);
  assert.deepEqual(strict, { applied: [], skipped: [], errors, demoted: [] });
  assert.deepEqual(await readMemory(dir), before);
  assert.equal(await exists(path.join(slateOf(dir), 'topics')), false);

  const r = await applyChanges(slateOf(dir), ops, { ...REORG, lenient: true });
  assert.deepEqual(r, { applied: ['3:topic build', '4:move F2>build'], skipped: [], errors, demoted: [] });
  for (const t of r.errors) assert.match(t, SAFE_TOKEN, t);
  const now = await readMemory(dir);
  assert.equal(now['facts.md'], '# Facts\n');
  assert.equal(now['instructions.md'], before['instructions.md']);
  assert.equal(now['now.md'], before['now.md'], "a session's now.md is never read or written");
  assert.equal(await readTopic(dir, 'build'), '# Build\n> How it builds.\n- [F2 t1] Node 24 (package.json)\n');
  assert.equal(await exists(path.join(slateOf(dir), 'now.md')), false);
  assert.ok(ERROR_KINDS.includes('op not allowed') && ERROR_KINDS.includes('no replacement'));
});

test('reorganize: a retire names a later item of the same type that is still live after the apply', async () => {
  const facts = '# Facts\n- [F2 t1] Node 24 (package.json)\n- [F3 t2] PR #1 in review (user)\n- [F4 t3] PR #1 approved (user)\n'
    + '- [F5 t4] PR #1 merged (user)\n';
  const { dir, before } = await slate({ ...BASE, 'facts.md': facts });
  const r = await applyChanges(slateOf(dir), [
    { op: 'retire', id: 'F3', reason: 'superseded by F2' }, // older
    { op: 'retire', id: 'F2', reason: 'no longer true' }, // names nothing
    { op: 'retire', id: 'F2', reason: 'replaced by F2' }, // itself
    { op: 'retire', id: 'F2', reason: 'see F9' }, // not live
    { op: 'retire', id: 'F2', reason: 'see A9' }, // retired before the apply, and another type
    { op: 'retire', id: 'A1', reason: 'confirmed by F2' }, // another type
    { op: 'retire', id: 'F3', reason: 'superseded by F4' }, // F4 is retired below: not live after the apply
    { op: 'retire', id: 'F4', reason: 'superseded by F5 (merged)' },
    { op: 'retire', id: 'F2', reason: '' },
    { op: 'retire', id: 'I1', reason: 'superseded by I2' }, // instructions are never retired here
  ], { ...REORG, lenient: true });
  assert.deepEqual(r.errors, ['0:no replacement F3', '1:no replacement F2', '2:no replacement F2', '3:no replacement F2',
    '4:no replacement F2', '5:no replacement A1', '6:no replacement F3', '8:empty reason', '9:instruction retire I1']);
  assert.deepEqual(r.applied, ['7:retire F4']);
  for (const t of r.errors) assert.match(t, SAFE_TOKEN, t);
  const now = await readMemory(dir);
  assert.equal(now['facts.md'], '# Facts\n- [F2 t1] Node 24 (package.json)\n- [F3 t2] PR #1 in review (user)\n'
    + '- [F5 t4] PR #1 merged (user)\n');
  assert.equal(now['instructions.md'], before['instructions.md']);
  assert.equal(now['assumptions.md'], before['assumptions.md']);
  assert.equal(now['superseded.md'], `${before['superseded.md']}`
    + '- [F4 t3 retired t0@reorg] PR #1 approved (user) (reason: superseded by F5 (merged))\n');
  assert.ok(ERROR_KINDS.includes('instruction retire'));
});

test('reorganize: whether a replacement stays live does not depend on op order, and a rejected retire leaves it live', async () => {
  const facts = '# Facts\n- [F3 t2] PR #1 in review (user)\n- [F4 t3] PR #1 approved (user)\n- [F5 t4] PR #1 merged (user)\n'
    + '- [F6 t5] PR #1 reverted (user)\n';
  // F3 names F4 and F4 names F5: F4 goes, so F3 stays, in either order.
  for (const order of [[0, 1], [1, 0]]) {
    const { dir } = await slate({ ...BASE, 'facts.md': facts });
    const ops = [{ op: 'retire', id: 'F3', reason: 'superseded by F4' }, { op: 'retire', id: 'F4', reason: 'superseded by F5' }];
    const r = await applyChanges(slateOf(dir), order.map((i) => ops[i]), { ...REORG, lenient: true });
    assert.deepEqual(r.applied, [`${order.indexOf(1)}:retire F4`], `order ${order}`);
    assert.deepEqual(r.errors, [`${order.indexOf(0)}:no replacement F3`], `order ${order}`);
  }
  // F5's own retire is rejected (it names no item), so F5 stays live and F4 may name it; F6 names F99.
  const { dir } = await slate({ ...BASE, 'facts.md': facts });
  const r = await applyChanges(slateOf(dir), [
    { op: 'retire', id: 'F4', reason: 'superseded by F5' },
    { op: 'retire', id: 'F5', reason: 'undone' },
    { op: 'retire', id: 'F3', reason: 'superseded by F5 and F6' },
  ], { ...REORG, lenient: true });
  assert.deepEqual(r.applied, ['0:retire F4', '2:retire F3']);
  assert.deepEqual(r.errors, ['1:no replacement F5']);
});

test('reorganize: keep stamps a key item and records its home; the caps then demote unkept items first', async () => {
  const lines = [itemLine('F1', 1000), itemLine('F2', 1000), itemLine('F3', 1100)];
  const { dir } = await slate({ ...BASE, 'facts.md': `# Facts\n${lines.join('\n')}\n` });
  await writeTopic(dir, 'build', BUILD);
  const r = await applyChanges(slateOf(dir), [
    { op: 'keep', id: 'F1', home: 'build' },
    { op: 'topic', slug: 'seo', title: 'SEO', summary: 'Search.' },
    { op: 'keep', id: 'F3', home: 'seo' },
    { op: 'keep', id: 'A1', home: 'general' },
  ], { ...REORG, lenient: true, now: T2 });
  assert.deepEqual(r, {
    applied: ['1:topic seo', '0:keep F1>build', '2:keep F3>seo', '3:keep A1>general'], skipped: [], errors: [], demoted: ['F2>general'],
  });
  assert.equal((await readMemory(dir))['facts.md'], `# Facts\n${lines[0]}\n${lines[2]}\n`);
  assert.deepEqual(await readUsage(dir), { A1: use(T2, 0, 'general'), F1: use(T2, 0, 'build'), F3: use(T2, 0, 'seo') });
});

test('reorganize: keep is rejected for a topic item, an instruction, a gone item, a missing topic, and outside reorganize mode', async () => {
  const { dir, before } = await slate();
  await writeTopic(dir, 'build', `${BUILD}- [F20 t1] uses vite (vite.config.ts)\n`);
  const ops = [
    { op: 'keep', id: 'F20', home: 'build' },
    { op: 'keep', id: 'I1', home: 'build' },
    { op: 'keep', id: 'F99', home: 'build' },
    { op: 'keep', id: 'F2', home: 'nowhere' },
    { op: 'keep', id: 'F2', home: 'Bad Slug' },
    { op: 'keep', id: 'F2' },
  ];
  const r = await applyChanges(slateOf(dir), ops, { ...REORG, lenient: true });
  assert.deepEqual(r.errors, ['0:not key F20', '1:not key I1', '2:stale F99', '3:missing topic', '4:bad slug', '5:bad op']);
  assert.deepEqual(r.applied, []);
  for (const t of r.errors) assert.match(t, SAFE_TOKEN, t);
  assert.equal(await exists(usagePath(dir)), false);
  assert.ok(ERROR_KINDS.includes('not key'));

  const normal = await applyChanges(dir, [{ op: 'keep', id: 'F2', home: 'build' }], { ...OPTS, lenient: true });
  assert.deepEqual(normal, { applied: [], skipped: [], errors: ['0:bad op'], demoted: [] });
  assert.deepEqual(await readMemory(dir), before);
});

test('reorganize: outside it, a retire\'s reason is free and every op is allowed', async () => {
  const { dir } = await slate();
  const r = await applyChanges(dir, [{ op: 'retire', id: 'F2', reason: 'no longer true' }, { op: 'now', text: 'Goal: x' }], OPTS);
  assert.deepEqual(r.applied, ['0:retire F2', '1:now']);
});

test('REORGANIZE_SCHEMA: ops of topic, move, retire and keep only; no relevant; CHANGE_SCHEMA has no keep', () => {
  assert.deepEqual(REORGANIZE_SCHEMA.required, ['ops']);
  assert.deepEqual(Object.keys(REORGANIZE_SCHEMA.properties), ['ops']);
  assert.equal(REORGANIZE_SCHEMA.additionalProperties, false);
  const shapes = REORGANIZE_SCHEMA.properties.ops.items.oneOf;
  assert.deepEqual(shapes.map((s) => s.properties.op.const), ['topic', 'move', 'retire', 'keep']);
  const same = (op) => CHANGE_SCHEMA.properties.ops.items.oneOf.find((s) => s.properties.op.const === op);
  for (const s of shapes.slice(0, 3)) assert.deepEqual(s, same(s.properties.op.const));
  assert.deepEqual(shapes[3], {
    type: 'object',
    properties: { op: { const: 'keep' }, id: { type: 'string' }, home: { type: 'string' } },
    required: ['op', 'id', 'home'],
    additionalProperties: false,
  });
  assert.equal(same('keep'), undefined);
});
