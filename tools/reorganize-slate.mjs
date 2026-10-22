#!/usr/bin/env node
// One-off: sort a slate's facts and assumptions into topic files with one model run.
// Usage: node tools/reorganize-slate.mjs <name> [--dry-run]   (honors SLATE_HOME)
// The curator binary, resolved and run with the env as curate.mjs does, reads the key files,
// superseded.md and the topic files, and returns only topic, move and retire ops. applyChanges
// applies them in reorganize mode, leniently: any other op, and any retire whose reason doesn't name
// its replacement, is dropped. Then the key-file caps apply. --dry-run applies to a scratch copy to
// show the plan, and changes nothing. Last, the accounting: every ID live before must be live after,
// or retired in superseded.md with a reason. The tool exits 1 if it isn't.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slateHome, validName, slateDir, readTopics } from '../plugins/slate/scripts/lib/slate.mjs';
import { applyChanges, REORGANIZE_SCHEMA, FACTS_CAP, ASSUMPTIONS_CAP } from '../plugins/slate/scripts/lib/apply.mjs';
import { ITEM_FILES, parseItemLine, parseMemoryFile } from '../plugins/slate/scripts/lib/items.mjs';
import {
  resolveClaudeBin, curatorEnv, runClaude, parseChanges, topicLine,
} from '../plugins/slate/scripts/curate.mjs';

const RULES_FILE = new URL('../plugins/slate/reorganize-rules.md', import.meta.url);
const ITEM_NAMES = Object.values(ITEM_FILES);
const SHARED = [...ITEM_NAMES, 'superseded.md'];
const CAPS = { 'facts.md': FACTS_CAP, 'assumptions.md': ASSUMPTIONS_CAP };
const USAGE = 'usage.json';
const MODEL = 'sonnet';
const TIMEOUT_MS = 15 * 60_000;
// Retired lines read `retired t0@reorg`: no session ran this.
const APPLY = { turn: 0, sessionId: 'reorg', lenient: true, reorganize: true };

function fail(msg) {
  console.error(`reorganize: ${msg}`);
  process.exit(1);
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// The slate's shared files, topic files and usage.json, as text.
export async function readState(slate) {
  const files = {};
  for (const f of SHARED) files[f] = await readText(path.join(slate, f));
  return { files, topics: await readTopics(slate), usage: await readText(path.join(slate, USAGE)) };
}

// Live IDs, each with its file, and retired IDs with their reasons.
export function idState({ files, topics }) {
  const live = new Map();
  for (const f of ITEM_NAMES) for (const x of parseMemoryFile(files[f]).items) live.set(x.id, f);
  for (const t of topics) for (const x of parseMemoryFile(t.text).items) live.set(x.id, `topics/${t.slug}.md`);
  const retired = new Map();
  for (const x of parseMemoryFile(files['superseded.md']).retired) {
    if (!retired.get(x.id)?.trim()) retired.set(x.id, x.reason);
  }
  return { live, retired };
}

// Every ID live before is live after, or retired with a non-empty reason.
export function accounting(before, after) {
  const gone = [...before.live.keys()].filter((id) => !after.live.has(id));
  const retired = gone.filter((id) => after.retired.get(id)?.trim());
  const lost = gone.filter((id) => !retired.includes(id));
  return { ok: lost.length === 0, lost, retired };
}

// Items per file: live items in the item and topic files, retired ones in superseded.md.
function counts({ files, topics }) {
  const out = {};
  for (const f of ['instructions.md', 'facts.md', 'assumptions.md']) out[f] = parseMemoryFile(files[f]).items.length;
  out['superseded.md'] = parseMemoryFile(files['superseded.md']).retired.length;
  for (const t of topics) out[`topics/${t.slug}.md`] = parseMemoryFile(t.text).items.length;
  return out;
}

// Chars of item lines, as the caps count them.
const itemChars = (text) => text.split('\n').map((l) => l.replace(/\r$/, ''))
  .filter((l) => parseItemLine(l)).reduce((n, l) => n + l.length, 0);

function buildPrompt(rules, real, { files, topics }) {
  const index = topics.map((t) => topicLine({ ...t, count: parseMemoryFile(t.text).items.length }));
  return [
    rules.trim(),
    '',
    '# This slate',
    '',
    'Files to read:',
    ...SHARED.map((f) => `- ${path.join(real, f)}`),
    '',
    ...(index.length ? ['Topics:', ...index] : ['Topics: none yet.']),
    '',
    'Key files now:',
    ...Object.entries(CAPS).map(([f, cap]) =>
      `- ${f}: ${parseMemoryFile(files[f]).items.length} items, ${itemChars(files[f])} chars (cap ${cap})`),
  ].join('\n');
}

// As curate.mjs runs the curator: read only, the change list on stdout, but this schema.
function modelArgs(prompt, real) {
  const rules = [...SHARED.map((f) => `Read(/${path.join(real, f)})`), `Read(/${path.join(real, 'topics')}/**)`];
  return [
    '-p', prompt,
    '--model', MODEL,
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(REORGANIZE_SCHEMA),
    '--tools', 'Read',
    '--allowedTools', ...rules,
  ];
}

const oneLine = (s) => String(s).replace(/\s*[\r\n]+\s*/g, ' ');
function describe(o, i) {
  const s = (...xs) => xs.every((x) => typeof x === 'string');
  let what = JSON.stringify(o);
  if (o?.op === 'topic' && s(o.slug, o.title, o.summary)) what = `topic ${o.slug} ${JSON.stringify(o.title)} — ${o.summary}`;
  else if (o?.op === 'move' && s(o.id, o.to)) what = `move ${o.id} > ${o.to}`;
  else if (o?.op === 'retire' && s(o.id, o.reason)) what = `retire ${o.id} (reason: ${o.reason})`;
  return `  ${i} ${oneLine(what)}`;
}

// A scratch slate holding `state`, for a dry run.
async function scratchCopy(name, { files, topics, usage }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-reorganize-'));
  const slate = path.join(root, name);
  await fs.mkdir(path.join(slate, 'topics'), { recursive: true });
  for (const f of SHARED) await fs.writeFile(path.join(slate, f), files[f]);
  for (const t of topics) await fs.writeFile(path.join(slate, 'topics', `${t.slug}.md`), t.text);
  if (usage) await fs.writeFile(path.join(slate, USAGE), usage);
  return { root, slate };
}

function report(before, after, r, dry) {
  const b = counts(before);
  const a = counts(after);
  const names = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const width = Math.max(...names.map((n) => n.length), 4);
  console.log(`\n${'file'.padEnd(width)}  before  ${dry ? 'planned' : 'after'}`);
  const cell = (x) => String(x ?? 0).padStart(6);
  for (const n of names) console.log(`${n.padEnd(width)}  ${cell(b[n])}  ${cell(a[n])}`);

  const n = (kind) => r.applied.filter((t) => new RegExp(`^\\d+:${kind} `).test(t)).length;
  console.log(`\ntopics: ${n('topic')}, moves: ${n('move')}, retires: ${n('retire')}, `
    + `demoted: ${r.demoted.length}, rejected: ${r.errors.length}`);
  if (r.errors.length) console.log(`rejected: ${r.errors.join('; ')}`);
  if (r.skipped.length) console.log(`skipped: ${r.skipped.join('; ')}`);
  if (r.demoted.length) console.log(`demoted by the caps: ${r.demoted.join(', ')}`);
  const sizes = Object.entries(CAPS).map(([f, cap]) => {
    const c = itemChars(after.files[f]);
    return `${f} ${c} / ${cap}${c > cap ? ' (OVER)' : ''}`;
  });
  console.log(`key file chars: ${sizes.join(', ')}`);

  const [was, now] = [idState(before), idState(after)];
  const acc = accounting(was, now);
  if (acc.ok) {
    console.log(`accounting: ok, ${was.live.size} IDs live before; ${now.live.size} live after, `
      + `${acc.retired.length} retired with a reason`);
  } else {
    console.log(`accounting: FAILED, neither live nor retired with a reason: ${acc.lost.join(', ')}`);
  }
  return acc.ok;
}

async function main(argv) {
  const dry = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  if (rest.length !== 1) fail('usage: reorganize-slate.mjs <name> [--dry-run]');
  const [name] = rest;
  if (!validName(name)) fail(`invalid name ${JSON.stringify(name)}: use a-z0-9 and single hyphens, at most 64 characters`);
  const slate = slateDir(slateHome(), name);
  if (!(await fs.stat(slate).catch(() => null))?.isDirectory()) fail(`no slate at ${slate}`);
  const real = realpathSync(slate);
  const before = await readState(real);
  const prompt = buildPrompt(await fs.readFile(RULES_FILE, 'utf8'), real, before);
  const bin = resolveClaudeBin();
  console.log(`reorganize ${real}${dry ? ' (dry run: the plan is applied to a scratch copy; the slate is unchanged)' : ''}`);
  console.log(`model ${MODEL}, via ${bin}`);

  // Ctrl-C or SIGTERM kills the model run, which is in its own process group.
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ac.abort());
  const started = Date.now();
  const run = await runClaude(bin, modelArgs(prompt, real), {
    cwd: real, env: curatorEnv(process.env), timeoutMs: TIMEOUT_MS, signal: ac.signal,
  });
  if (run.error) fail(`model run failed (${run.error}); nothing changed`);
  const changes = parseChanges(run.stdout);
  if (!changes) fail('no op list in the model output; nothing changed');
  let cost = null;
  try {
    cost = JSON.parse(run.stdout).total_cost_usd ?? null;
  } catch {}
  console.log(`model run: ${Math.round((Date.now() - started) / 1000)} s${cost === null ? '' : `, $${cost}`}`);
  console.log(`\nops (${changes.ops.length}):`);
  changes.ops.forEach((o, i) => console.log(describe(o, i)));

  const scratch = dry ? await scratchCopy(name, before) : null;
  try {
    const target = scratch ? scratch.slate : real;
    const r = await applyChanges(target, changes.ops, APPLY);
    if (!report(before, await readState(target), r, dry)) process.exitCode = 1;
  } catch (e) {
    // applyChanges writes nothing before it has checked every op, and each file atomically.
    console.error(`reorganize: apply failed (${e.message})`);
    process.exitCode = 1;
  } finally {
    if (scratch) await fs.rm(scratch.root, { recursive: true, force: true });
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) await main(process.argv.slice(2));
