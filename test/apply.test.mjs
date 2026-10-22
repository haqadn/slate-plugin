import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { applyChanges, CHANGE_SCHEMA } from '../plugins/slate/scripts/lib/apply.mjs';
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
    { op: 'add', type: 'A', text: 'deploys run nightly' },
    { op: 'add', type: 'F', text: 'port 8080 (config.yml)' },
  ], OPTS);
  assert.deepEqual(r, { applied: ['0:add I8', '1:add A10', '2:add F3'], skipped: [], errors: [] });
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
  await applyChanges(dir, [{ op: 'add', type: 'F', text: 'y (user)' }], OPTS);
  assert.equal((await readMemory(dir))['facts.md'], `# Facts\n- [F2 t1] Node 24 (package.json)\n- [F3 ${TAG}] y (user)\n`);
});

test('retire: the exact line moves to superseded.md with the retired tag and reason; old and new tags', async () => {
  const { dir, before } = await slate();
  const r = await applyChanges(dir, [
    { op: 'retire', id: 'I1', reason: 'user switched to pnpm' },
    { op: 'retire', id: 'I2', reason: 'not needed' },
  ], OPTS);
  assert.deepEqual(r, { applied: ['0:retire I1', '1:retire I2'], skipped: [], errors: [] });
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
  assert.deepEqual(r, { applied: ['0:replace I1 I8', '1:replace F2 F3'], skipped: [], errors: [] });
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
  assert.deepEqual(r, { applied: ['0:now'], skipped: [], errors: [] });
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
  assert.deepEqual(r, { applied: ['adopt I8', 'adopt F1'], skipped: [], errors: [] });
  const now = await readMemory(dir);
  assert.equal(now['instructions.md'], '# Instructions\n- [I1 t1] use npm\n- [I8 t0] prefer tabs  \nfree text line\n* star bullet\n' +
    '- [I3] malformed tag\n- ~~use yarn~~ (retired I7)\n');
  assert.equal(now['facts.md'], '# Facts\r\n- [F1 t0] repo is at /srv/app (user)\r\n');
});

test('an add whose text matches a live item exactly is skipped, adopted bullets and same-list adds included', async () => {
  const { dir, before } = await slate({ ...BASE, 'assumptions.md': '# Assumptions\n- prefer tabs\n' });
  const r = await applyChanges(dir, [
    { op: 'add', type: 'I', text: 'use npm' },
    { op: 'add', type: 'A', text: 'prefer tabs' },
    { op: 'add', type: 'I', text: 'new rule' },
    { op: 'add', type: 'I', text: 'new rule' },
    { op: 'add', type: 'I', text: 'use yarn' }, // retired, not live: added again
  ], OPTS);
  assert.deepEqual(r, {
    applied: ['adopt A10', '2:add I8', '4:add I9'],
    skipped: ['0:duplicate I1', '1:duplicate A10', '3:duplicate I8'],
    errors: [],
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
  assert.deepEqual(r, { applied: [], skipped: [], errors: ['1:stale I7', '2:stale F9'] });
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
    { op: 'add', type: 'A', text: 'fine' },
  ], { ...OPTS, lenient: true });
  assert.deepEqual(r, { applied: ['0:add I8', '2:add A10'], skipped: [], errors: ['0:stale I5', '1:stale A3'] });
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
];

for (const [name, op, kind] of INVALID) {
  test(`invalid: ${name} → ${kind}; strict applies nothing, lenient drops only that op`, async () => {
    const { dir, before } = await slate();
    const fix = (o) => (o && typeof o.text === 'string' ? { ...o, text: o.text.replace(ROOT_SLATE, slateOf(dir)) } : o);
    const ops = [{ op: 'add', type: 'I', text: 'valid rule' }, fix(op)];
    const strict = await applyChanges(dir, ops, OPTS);
    assert.deepEqual(strict, { applied: [], skipped: [], errors: [`1:${kind}`] });
    assertSafe(strict);
    assert.deepEqual(await readMemory(dir), before);

    const lenient = await applyChanges(dir, ops, { ...OPTS, lenient: true });
    assert.deepEqual(lenient, { applied: ['0:add I8'], skipped: [], errors: [`1:${kind}`] });
    const now = await readMemory(dir);
    assert.equal(now['instructions.md'], `${before['instructions.md']}- [I8 ${TAG}] valid rule\n`);
    for (const f of ['assumptions.md', 'facts.md', 'superseded.md', 'now.md']) assert.equal(now[f], before[f], f);
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
    { op: 'add', type: 'F', text: 'tests pass (npm test (v2))' },
  ], OPTS);
  assert.deepEqual(r.errors, []);
  assert.equal((await readMemory(dir))['now.md'], `${ten}\n`);
  await applyChanges(dir, [{ op: 'now', text: '' }], OPTS);
  assert.equal((await readMemory(dir))['now.md'], '');
});

test('CHANGE_SCHEMA: ops is a list of four closed op shapes; add has no id', () => {
  assert.deepEqual(CHANGE_SCHEMA.required, ['ops']);
  assert.equal(CHANGE_SCHEMA.additionalProperties, false);
  const shapes = CHANGE_SCHEMA.properties.ops.items.oneOf;
  const byOp = Object.fromEntries(shapes.map((s) => [s.properties.op.const, s]));
  assert.deepEqual(Object.keys(byOp).sort(), ['add', 'now', 'replace', 'retire']);
  const fields = { add: ['op', 'type', 'text'], retire: ['op', 'id', 'reason'], replace: ['op', 'id', 'text', 'reason'], now: ['op', 'text'] };
  for (const [op, keys] of Object.entries(fields)) {
    assert.equal(byOp[op].additionalProperties, false, op);
    assert.deepEqual(Object.keys(byOp[op].properties).sort(), [...keys].sort(), op);
    assert.deepEqual([...byOp[op].required].sort(), [...keys].sort(), op);
  }
  assert.deepEqual(byOp.add.properties.type.enum, ['I', 'A', 'F']);
});

// --- memory.lock ---

// A child process that runs `code` with argv [module URL, ...args].
function child(code, args, stdio = ['ignore', 'pipe', 'pipe']) {
  return spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio });
}

const ADD_MANY = `
const [mod, dir, sid, tag, start] = process.argv.slice(1);
const { applyChanges } = await import(mod);
await new Promise((r) => setTimeout(r, Math.max(0, Number(start) - Date.now())));
for (let i = 1; i <= 20; i++) {
  const r = await applyChanges(dir, [{ op: 'add', type: 'I', text: tag + ' ' + i }], { turn: i, sessionId: sid });
  if (r.applied.length !== 1) throw new Error(JSON.stringify(r));
}
`;

test('Review Focus 2: two processes applying 20 adds each at once lose nothing and share no ID', async () => {
  const { dir } = await slate({ 'instructions.md': '# Instructions\n', 'superseded.md': '# Superseded\n' });
  const { dir: other } = await createSession(slateOf(dir), 'bbbbbbbb-other', 2);
  const start = String(Date.now() + 500);
  const kids = [[dir, SID, 'from a'], [other, 'bbbbbbbb-other', 'from b']]
    .map(([d, sid, tag]) => child(ADD_MANY, [APPLY, d, sid, tag, start], ['ignore', 'ignore', 'inherit']));
  const codes = await Promise.all(kids.map(async (k) => (await once(k, 'exit'))[0]));
  assert.deepEqual(codes, [0, 0]);

  const lines = (await readMemory(dir))['instructions.md'].split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 40);
  const ids = lines.map((l) => /^- \[(I\d+) /.exec(l)[1]);
  assert.equal(new Set(ids).size, 40, 'unique IDs');
  assert.deepEqual(ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
  const texts = new Set(lines.map((l) => l.replace(/^- \[[^\]]*\] /, '')));
  for (const tag of ['from a', 'from b']) for (let i = 1; i <= 20; i++) assert.ok(texts.has(`${tag} ${i}`), `${tag} ${i}`);
  assert.ok(lines.some((l) => l.includes('@82b3114c]')) && lines.some((l) => l.includes('@bbbbbbbb]')));
  const left = (await fs.readdir(slateOf(dir))).filter((n) => n.endsWith('.lock') || n.endsWith('.tmp'));
  assert.deepEqual(left, [], 'no lock or temp file left behind');
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
  assert.equal((await fs.readFile(lock, 'utf8')).trim(), String(holder.pid), 'the dead holder left its lock');

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
