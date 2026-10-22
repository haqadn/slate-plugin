import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSlate } from '../plugins/slate/scripts/lib/slate.mjs';
import { REORGANIZE_SCHEMA, FACTS_CAP, ASSUMPTIONS_CAP } from '../plugins/slate/scripts/lib/apply.mjs';
import { parseItemLine, parseMemoryFile } from '../plugins/slate/scripts/lib/items.mjs';
import { idState, accounting } from '../tools/reorganize-slate.mjs';

const TOOL = fileURLToPath(new URL('../tools/reorganize-slate.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const RULES = fileURLToPath(new URL('../plugins/slate/reorganize-rules.md', import.meta.url));
const NAME = 'seo';

const temps = [];
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
// Belt and braces: a bin that falls through to plain `claude` hits this stub, never a real model.
const NO_CLAUDE = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-noclaude-'));
temps.push(NO_CLAUDE);
await fs.writeFile(path.join(NO_CLAUDE, 'claude'), '#!/bin/sh\necho "test reached claude on PATH" >&2\nexit 97\n', {
  mode: 0o755,
});

// 30 facts in three areas and 5 assumptions, all in the key files, as a migrated slate has them.
// F8 is a status that F9 replaces. facts.md starts over its cap.
const AREAS = ['canonical', 'sitemap', 'schema'];
const areaOf = (n) => AREAS[Math.floor((n - 1) / 10)];
function factText(n) {
  if (n === 8) return '2026-10-01: canonical PR #12 in review (user)';
  if (n === 9) return '2026-10-15: canonical PR #12 merged (user)';
  return `${areaOf(n)} fact ${n}: ${'lorem '.repeat(14)}(notes.md)`;
}
const FACTS = `# Facts\n${Array.from({ length: 30 }, (_, i) => `- [F${i + 1} t${i + 1}] ${factText(i + 1)}`).join('\n')}\n`;
const ASSUMPTIONS = `# Assumptions\n${[1, 2, 3, 4, 5].map((n) => `- [A${n} t2@0ther000] ${AREAS[(n - 1) % 3]} guess ${n}: ${'ipsum '.repeat(10)}`).join('\n')}\n`;
const INSTRUCTIONS = '# Instructions\n- [I1 t1] Keep replies short.\n- [I2 t3@82b3114c] Use pnpm.\n';
const SUPERSEDED = '# Superseded\n- [F31 t1 retired t2] an old fact (x) (reason: gone)\n';

const TOPIC_OPS = AREAS.map((slug) => ({ op: 'topic', slug, title: slug[0].toUpperCase() + slug.slice(1), summary: `All about ${slug}.` }));
const KEEP = new Set(['F1', 'F11', 'F21', 'A4', 'A5']);
const MOVES = [
  ...Array.from({ length: 30 }, (_, i) => i + 1).filter((n) => !KEEP.has(`F${n}`) && n !== 8)
    .map((n) => ({ op: 'move', id: `F${n}`, to: areaOf(n) })),
  ...[1, 2, 3].map((n) => ({ op: 'move', id: `A${n}`, to: AREAS[(n - 1) % 3] })),
];
const RETIRE_F8 = { op: 'retire', id: 'F8', reason: 'superseded by F9' };
// Every item left in a key file gets a keep with its home topic.
const KEEPS = [...KEEP].map((id) => ({ op: 'keep', id, home: id[0] === 'F' ? areaOf(Number(id.slice(1))) : AREAS[(Number(id.slice(1)) - 1) % 3] }));
const FULL = [...TOPIC_OPS, ...MOVES, RETIRE_F8, ...KEEPS];

async function fixture() {
  const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'slate-reorg-')));
  temps.push(root);
  const home = path.join(root, 'home');
  const { dir } = await createSlate(home, NAME);
  await fs.writeFile(path.join(dir, 'facts.md'), FACTS);
  await fs.writeFile(path.join(dir, 'assumptions.md'), ASSUMPTIONS);
  await fs.writeFile(path.join(dir, 'instructions.md'), INSTRUCTIONS);
  await fs.writeFile(path.join(dir, 'superseded.md'), SUPERSEDED);
  const session = path.join(dir, '.sessions', 'sid');
  await fs.mkdir(session, { recursive: true });
  await fs.writeFile(path.join(session, 'now.md'), 'Goal: ship\n');
  const tmp = path.join(root, 'tmp');
  await fs.mkdir(tmp);
  return { root, home, slate: dir, tmp, record: path.join(root, 'record.jsonl') };
}

function run(fx, args, { ops = FULL, mode = 'ops', env = {} } = {}) {
  const opsFile = path.join(fx.root, `ops-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(opsFile, JSON.stringify(ops));
  const e = {
    ...process.env,
    SLATE_HOME: fx.home,
    SLATE_CLAUDE_BIN: FAKE,
    FAKE_MODE: mode,
    FAKE_OPS: opsFile,
    FAKE_RECORD: fx.record,
    TMPDIR: fx.tmp,
    PATH: `${NO_CLAUDE}${path.delimiter}${process.env.PATH}`,
    ...env,
  };
  delete e.CLAUDE_CODE_EXECPATH;
  return spawnSync(process.execPath, [TOOL, ...args], { env: e, encoding: 'utf8' });
}

async function snapshot(dir) {
  const out = {};
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) {
      const p = path.join(e.parentPath, e.name);
      out[path.relative(dir, p)] = await fs.readFile(p, 'utf8');
    }
  }
  return out;
}
const read = (slate, f) => fs.readFile(path.join(slate, f), 'utf8');
const ids = (text) => parseMemoryFile(text).items.map((x) => x.id);
const itemChars = (text) => text.split('\n').filter((l) => parseItemLine(l)).reduce((n, l) => n + l.length, 0);
async function calls(record) {
  try {
    return (await fs.readFile(record, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
const exists = (p) => fs.access(p).then(() => true, () => false);
// Every live item line in the item files and topic files. (The caps may have moved key items to general.)
async function liveLines(slate) {
  const texts = await Promise.all(['instructions.md', 'facts.md', 'assumptions.md'].map((f) => read(slate, f)));
  const topics = path.join(slate, 'topics');
  for (const f of (await exists(topics)) ? await fs.readdir(topics) : []) texts.push(await read(slate, `topics/${f}`));
  return texts.join('\n').split('\n').filter((l) => parseItemLine(l));
}

test('a run moves items into topics, retires the replaced status, leaves key files under their caps, and accounts for every ID', async () => {
  const fx = await fixture();
  const r = run(fx, [NAME]);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  assert.deepEqual(ids(await read(fx.slate, 'facts.md')), ['F1', 'F11', 'F21']);
  assert.deepEqual(ids(await read(fx.slate, 'assumptions.md')), ['A4', 'A5']);
  assert.equal(await read(fx.slate, 'instructions.md'), INSTRUCTIONS);
  assert.deepEqual(ids(await read(fx.slate, 'topics/canonical.md')), ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F9', 'F10', 'A1']);
  assert.deepEqual(ids(await read(fx.slate, 'topics/sitemap.md')),
    ['F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'A2']);
  assert.match(await read(fx.slate, 'topics/schema.md'), /^# Schema\n> All about schema\.\n- \[F22 t22\] schema fact 22: /);
  // Lines move byte for byte.
  assert.ok((await read(fx.slate, 'topics/canonical.md')).includes(`- [F9 t9] ${factText(9)}\n`));
  assert.equal(await read(fx.slate, 'superseded.md'),
    `${SUPERSEDED}- [F8 t8 retired t0@reorg] ${factText(8)} (reason: superseded by F9)\n`);

  assert.ok(itemChars(await read(fx.slate, 'facts.md')) <= FACTS_CAP);
  assert.ok(itemChars(await read(fx.slate, 'assumptions.md')) <= ASSUMPTIONS_CAP);
  assert.ok(itemChars(FACTS) > FACTS_CAP, 'the fixture starts over the cap');

  // Per-file item counts before and after, then the totals and the accounting line.
  assert.match(r.stdout, /^instructions\.md\s+2\s+2$/m);
  assert.match(r.stdout, /^facts\.md\s+30\s+3$/m);
  assert.match(r.stdout, /^assumptions\.md\s+5\s+2$/m);
  assert.match(r.stdout, /^superseded\.md\s+1\s+2$/m);
  assert.match(r.stdout, /^topics\/canonical\.md\s+0\s+9$/m);
  assert.match(r.stdout, /^topics\/sitemap\.md\s+0\s+10$/m);
  assert.match(r.stdout, /^topics\/schema\.md\s+0\s+10$/m);
  assert.match(r.stdout, /^topics: 3, moves: 29, keeps: 5, retires: 1, demoted: 0, rejected: 0$/m);
  assert.match(r.stdout, /^key items without a home: none$/m);
  assert.match(r.stdout, /^accounting: ok\b/m);
  const usage = JSON.parse(await read(fx.slate, 'usage.json'));
  assert.deepEqual(Object.fromEntries(Object.entries(usage).map(([id, u]) => [id, u.home])),
    { A4: 'canonical', A5: 'sitemap', F1: 'canonical', F11: 'sitemap', F21: 'schema' });
  for (const u of Object.values(usage)) assert.ok(Date.parse(u.last) > 0 && u.count === 0, 'kept items are stamped');
  assert.equal(await read(fx.slate, '.sessions/sid/now.md'), 'Goal: ship\n', 'no session file is touched');
  assert.equal(await exists(path.join(fx.slate, 'memory.lock')), false);
});

test('command: one read-only run of the curator binary, Read on the key files, superseded.md and topics/**, only topic, move and retire in the schema', async () => {
  const fx = await fixture();
  await fs.mkdir(path.join(fx.slate, 'topics'));
  await fs.writeFile(path.join(fx.slate, 'topics', 'build.md'), '# Build\n> How it builds.\n- [F40 t1] uses vite (vite.config.ts)\n');
  const r = run(fx, [NAME], { env: { CLAUDE_CODE_SESSION_ID: 'parent', SLATE_TEST_INHERITED: 'yes' } });
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(fx.record);
  assert.equal(all.length, 1, 'the model runs once');
  const [{ args, env, cwd, prompt }] = all;
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(args[0], '-p');
  assert.equal(args[1], prompt);
  assert.equal(flag('--model'), 'sonnet');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--settings'), '{"disableAllHooks":true}');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--tools'), 'Read');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(f), f);
  assert.deepEqual(JSON.parse(flag('--json-schema')), REORGANIZE_SCHEMA);
  assert.deepEqual(REORGANIZE_SCHEMA.properties.ops.items.oneOf.map((s) => s.properties.op.const), ['topic', 'move', 'retire', 'keep']);
  const real = realpathSync(fx.slate);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), [
    ...['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md'].map((f) => `Read(/${path.join(real, f)})`),
    `Read(/${path.join(real, 'topics')}/**)`,
  ]);
  assert.equal(cwd, real);
  assert.equal(env.SLATE_CURATOR, '1');
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined, 'session identity is stripped');
  assert.equal(env.SLATE_TEST_INHERITED, 'yes');

  // The prompt: the rules, the files to read, the topic index and the key files' size against their caps.
  assert.ok(prompt.startsWith((await fs.readFile(RULES, 'utf8')).trim()));
  for (const f of ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md']) {
    assert.match(prompt, new RegExp(`^- ${path.join(real, f).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
  }
  assert.ok(prompt.includes(`- build: Build — How it builds. (1 items) ${path.join(real, 'topics', 'build.md')}`), prompt);
  assert.match(prompt, new RegExp(`facts\\.md: 30 items, ${itemChars(FACTS)} chars \\(cap 3000\\)`));
  assert.match(prompt, /assumptions\.md: 5 items, \d+ chars \(cap 1500\)/);
});

test('--dry-run prints the op list and the planned counts, saves the list, and changes no file', async () => {
  const fx = await fixture();
  const before = await snapshot(fx.slate);
  const r = run(fx, [NAME, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await snapshot(fx.slate), before);
  assert.equal(await exists(path.join(fx.slate, 'topics')), false);
  const saved = /^ops saved to (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(saved, r.stdout);
  assert.deepEqual(await fs.readdir(fx.tmp), [path.basename(saved)], 'its scratch copy is removed; the saved list stays');
  assert.equal(path.dirname(saved), fx.tmp);
  const plan = JSON.parse(await fs.readFile(saved, 'utf8'));
  assert.deepEqual(plan.ops, FULL);
  assert.equal(plan.slate, realpathSync(fx.slate));
  assert.match(r.stdout, /dry run/i);
  assert.match(r.stdout, /^ {2}0 topic canonical "Canonical" — All about canonical\.$/m);
  assert.match(r.stdout, /^ {2}3 move F2 > canonical$/m);
  assert.match(r.stdout, /^ {2}31 move A3 > schema$/m);
  assert.match(r.stdout, /^ {2}32 retire F8 \(reason: superseded by F9\)$/m);
  assert.match(r.stdout, /^facts\.md\s+30\s+3$/m);
  assert.match(r.stdout, /^topics\/canonical\.md\s+0\s+9$/m);
  assert.match(r.stdout, /^accounting: ok\b/m);
});

test('add, replace and now are rejected; the topic, move and retire ops in the same list still apply', async () => {
  const fx = await fixture();
  const r = run(fx, [NAME], {
    ops: [
      { op: 'add', type: 'F', text: 'a new fact (user)', topic: 'canonical' },
      { op: 'replace', id: 'F2', text: 'canonical fact 2 reworded (notes.md)', reason: 'clearer' },
      { op: 'now', text: 'Goal: x' },
      TOPIC_OPS[0],
      { op: 'move', id: 'F3', to: 'canonical' },
      RETIRE_F8,
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^rejected: 0:op not allowed; 1:op not allowed; 2:op not allowed$/m);
  const lines = await liveLines(fx.slate);
  assert.ok(lines.includes(`- [F2 t2] ${factText(2)}`), 'F2 is not replaced');
  assert.equal(lines.length, 2 + 30 + 5 - 1, 'nothing added, only F8 retired');
  assert.deepEqual(ids(await read(fx.slate, 'topics/canonical.md')), ['F3']);
  const all = Object.values(await snapshot(fx.slate)).join('\n');
  assert.ok(!all.includes('a new fact') && !all.includes('reworded'), 'nothing added');
  assert.match(await read(fx.slate, 'superseded.md'), /\[F8 t8 retired t0@reorg\]/);
  assert.match(r.stdout, /^topics: 1, moves: 1, keeps: 0, retires: 1, demoted: \d+, rejected: 3$/m);
  assert.match(r.stdout, /^key items without a home: F5, F6, ([AF]\d+, )*A5$/m, 'no keep, so no home');
  assert.match(r.stdout, /^accounting: ok\b/m);
});

test('a retire needs a reason naming the later item that replaces it; others are rejected', async () => {
  const fx = await fixture();
  const r = run(fx, [NAME], {
    ops: [
      { op: 'retire', id: 'F8', reason: '' },
      { op: 'retire', id: 'F7' },
      { op: 'retire', id: 'F6', reason: 'out of date' },
      { op: 'retire', id: 'F9', reason: 'superseded by F8' },
      { op: 'retire', id: 'F5', reason: 'superseded by F99' },
      { op: 'retire', id: 'F4', reason: 'replaced by F4' },
      { op: 'retire', id: 'A1', reason: 'confirmed by F3' },
      RETIRE_F8,
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp('^rejected: 0:empty reason; 1:bad op; 2:no replacement F6; 3:no replacement F9; '
    + '4:no replacement F5; 5:no replacement F4; 6:no replacement A1$', 'm'));
  const live = (await liveLines(fx.slate)).map((l) => parseItemLine(l).id);
  for (const id of ['F4', 'F5', 'F6', 'F7', 'F9']) assert.ok(live.includes(id), id);
  assert.ok(!live.includes('F8') && live.includes('A1'), 'an assumption is not retired by a fact');
  const retired = parseMemoryFile(await read(fx.slate, 'superseded.md')).retired.map((x) => `${x.id}: ${x.reason}`);
  assert.deepEqual(retired, ['F31: gone', 'F8: superseded by F9']);
  assert.match(r.stdout, /^accounting: ok\b/m);
});

test('a failed model run or an output with no op list changes nothing and exits non-zero', async () => {
  for (const mode of ['fail', 'garbage']) {
    const fx = await fixture();
    const before = await snapshot(fx.slate);
    const r = run(fx, [NAME], { mode });
    assert.notEqual(r.status, 0, mode);
    assert.match(r.stderr, /reorganize: /, mode);
    assert.deepEqual(await snapshot(fx.slate), before, mode);
  }
});

test('a bad name or a missing slate is refused, and nothing is created', async () => {
  const fx = await fixture();
  let r = run(fx, ['Jetpack SEO']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /a-z0-9/);
  r = run(fx, ['nope']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no slate/);
  assert.equal(await exists(path.join(fx.home, 'nope')), false);
  r = run(fx, []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/);
  assert.deepEqual(await calls(fx.record), [], 'no model run');
});

const state = (files, topics = []) => idState({
  files: { 'instructions.md': '', 'assumptions.md': '', 'facts.md': '', 'superseded.md': '', ...files },
  topics: topics.map(([slug, text]) => ({ slug, text })),
});

test('accounting: an ID live before must be live after, or retired in superseded.md with a non-empty reason', () => {
  const before = state({
    'facts.md': '- [F1 t1] a (x)\n- [F2 t1] b (x)\n- [F3 t1] c (x)\n- [F4 t1] d (x)\n',
    'instructions.md': '- [I1 t1] keep\n',
  });
  const after = state({
    'superseded.md': '- [F2 t1 retired t0@reorg] b (x) (reason: superseded by F5)\n- [F3 t1 retired t0@reorg] c (x) (reason:  )\n',
    'instructions.md': '- [I1 t1] keep\n',
  }, [['misc', '# Misc\n> M.\n- [F1 t1] a (x)\n- [F5 t2] e (x)\n']]);
  assert.deepEqual(accounting(before, after), { ok: false, lost: ['F3', 'F4'], duplicated: [], retired: ['F2'] });
  assert.deepEqual(accounting(before, before), { ok: true, lost: [], duplicated: [], retired: [] });
});

test('accounting: only a retired line this run added counts; an old one for the same ID does not', () => {
  const old = '- [F2 t1 retired t3] b (x) (reason: an older copy)\n';
  const before = state({ 'facts.md': '- [F1 t1] a (x)\n- [F2 t4] b (x)\n', 'superseded.md': old });
  const dropped = state({ 'facts.md': '- [F1 t1] a (x)\n', 'superseded.md': old });
  assert.deepEqual(accounting(before, dropped), { ok: false, lost: ['F2'], duplicated: [], retired: [] });
  const retired = state({ 'facts.md': '- [F1 t1] a (x)\n', 'superseded.md': `${old}- [F2 t4 retired t0@reorg] b (x) (reason: by F9)\n` });
  assert.deepEqual(accounting(before, retired), { ok: true, lost: [], duplicated: [], retired: ['F2'] });
  const noReason = state({ 'facts.md': '- [F1 t1] a (x)\n', 'superseded.md': `${old}- [F2 t4 retired t0@reorg] b (x) (reason: )\n` });
  assert.deepEqual(accounting(before, noReason).lost, ['F2']);
});

test('accounting: live lines are counted per ID; a dropped copy or an extra copy fails', () => {
  const twice = state({ 'facts.md': '- [F1 t1] a (x)\n- [F1 t1] a (x)\n' });
  const once = state({ 'facts.md': '- [F1 t1] a (x)\n' });
  assert.deepEqual(accounting(twice, once), { ok: false, lost: ['F1'], duplicated: [], retired: [] });
  assert.deepEqual(accounting(twice, twice).ok, true);
  const moved = state({ 'facts.md': '- [F1 t1] a (x)\n' }, [['misc', '# Misc\n> M.\n- [F1 t1] a (x)\n']]);
  assert.deepEqual(accounting(once, moved), { ok: false, lost: [], duplicated: ['F1'], retired: [] });
  const fresh = state({ 'facts.md': '- [F1 t1] a (x)\n- [F9 t0] new (x)\n- [F9 t0] new (x)\n' });
  assert.deepEqual(accounting(once, fresh), { ok: false, lost: [], duplicated: ['F9'], retired: [] });
  const adopted = state({ 'facts.md': '- [F1 t1] a (x)\n- [F9 t0] new (x)\n' });
  assert.deepEqual(accounting(once, adopted).ok, true, 'a new ID once is fine');
});

test('--ops applies a saved list exactly, with no model run, even with no model binary', async () => {
  const fx = await fixture();
  const dry = run(fx, [NAME, '--dry-run', '--save', path.join(fx.root, 'plan.json')]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`^ops saved to ${path.join(fx.root, 'plan.json').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
  assert.equal((await calls(fx.record)).length, 1);

  // The model would now plan something else, and there is no binary to run it anyway.
  const r = run(fx, [NAME, '--ops', path.join(fx.root, 'plan.json')], {
    ops: [{ op: 'move', id: 'F2', to: 'general' }], env: { SLATE_CLAUDE_BIN: path.join(fx.root, 'no-such-claude') },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal((await calls(fx.record)).length, 1, 'no model run');
  assert.match(r.stdout, /^ops \(38\) from .*plan\.json/m);
  assert.match(r.stdout, /^topics: 3, moves: 29, keeps: 5, retires: 1, demoted: 0, rejected: 0$/m);
  assert.match(r.stdout, /^accounting: ok\b/m);
  assert.deepEqual(ids(await read(fx.slate, 'facts.md')), ['F1', 'F11', 'F21']);
  assert.equal(await exists(path.join(fx.slate, 'topics', 'general.md')), false);

  // The dry run printed the same counts it now applied.
  const table = (out) => out.split('\n').filter((l) => /^(topics\/)?[a-z-]+\.md\s/.test(l)).join('\n');
  assert.equal(table(r.stdout), table(dry.stdout));
});

test('--ops refuses a list saved for another slate, and a file that holds no list', async () => {
  const fx = await fixture();
  const other = path.join(fx.root, 'other.json');
  await fs.writeFile(other, JSON.stringify({ slate: '/somewhere/else', ops: FULL }));
  const before = await snapshot(fx.slate);
  let r = run(fx, [NAME, '--ops', other]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /planned for \/somewhere\/else/);
  await fs.writeFile(other, '{"nope": 1}');
  r = run(fx, [NAME, '--ops', other]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no op list/);
  r = run(fx, [NAME, '--ops', path.join(fx.root, 'missing.json')]);
  assert.notEqual(r.status, 0);
  assert.deepEqual(await snapshot(fx.slate), before);
  assert.deepEqual(await calls(fx.record), []);
});

test('reorganize-rules.md: the rules the reorganize pass relies on', async () => {
  const rules = await fs.readFile(RULES, 'utf8');
  assert.match(rules, /Group items into topics a reader would look for/);
  assert.match(rules, /Keep in the key files only what most sessions need on most turns, within the caps/);
  assert.match(rules, /3,000 chars of item lines in `facts\.md` and 1,500 in `assumptions\.md`/);
  assert.match(rules, /Retire only an item a later item explicitly replaces/);
  assert.match(rules, /reason names the replacing ID/);
  assert.match(rules, /Never reword/);
  for (const op of ['topic', 'move', 'retire', 'keep']) assert.match(rules, new RegExp(`^\\| \`${op}\` \\|`, 'm'), op);
  assert.match(rules, /For every F and A item you leave in a key file, return a `keep`/);
  assert.match(rules, /an item of the same type that stays live/);
  assert.match(rules, /Instructions are never retired here/);
  assert.doesNotMatch(rules, /^\| `(add|replace|now)` \|/m);
});
