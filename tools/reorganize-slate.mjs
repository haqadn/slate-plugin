#!/usr/bin/env node
// One-off: sort a slate's facts and assumptions into topic files with one model run.
// Usage: node tools/reorganize-slate.mjs <name> [--dry-run] [--save <file>] [--ops <file>]
// (honors SLATE_HOME)
// The curator binary, resolved and run with the env as curate.mjs does, reads the key files,
// superseded.md and the topic files, and returns only topic, move, retire and keep ops. applyChanges
// applies them in reorganize mode, leniently: any other op, and any retire whose reason doesn't name
// its replacement, is dropped. Then the key-file caps apply.
// --dry-run applies to a scratch copy to show the plan, changes nothing, and saves the op list (to
// --save <file>, else a temp file). --ops <file> applies a saved list with no model run. Last, the
// accounting: every live line before is live after, or retired by this run with a reason, and no ID
// gains a copy. The tool exits 1 if not.
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

const bump = (map, id) => map.set(id, (map.get(id) ?? 0) + 1);

// Per ID: how many live lines carry it (item and topic files), and how many retired lines with a
// non-empty reason superseded.md holds for it.
export function idState({ files, topics }) {
  const live = new Map();
  const retired = new Map();
  for (const f of ITEM_NAMES) for (const x of parseMemoryFile(files[f]).items) bump(live, x.id);
  for (const t of topics) for (const x of parseMemoryFile(t.text).items) bump(live, x.id);
  for (const x of parseMemoryFile(files['superseded.md']).retired) if (x.reason.trim()) bump(retired, x.id);
  return { live, retired };
}

const byId = (a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1));

// Each live line before is live after or retired by this run with a reason: its live lines plus the
// retired lines this run added match what it had. More means an extra copy; a new ID appears once.
// A retired line from before the run never accounts for an item.
export function accounting(before, after) {
  const lost = [];
  const duplicated = [];
  const retired = [];
  for (const id of new Set([...before.live.keys(), ...after.live.keys()])) {
    const was = before.live.get(id) ?? 0;
    const live = after.live.get(id) ?? 0;
    const added = Math.max(0, (after.retired.get(id) ?? 0) - (before.retired.get(id) ?? 0));
    if (was === 0 ? live > 1 : live + added > was) duplicated.push(id);
    else if (live + added < was) lost.push(id);
    else if (live < was) retired.push(id);
  }
  [lost, duplicated, retired].forEach((list) => list.sort(byId));
  return { ok: lost.length === 0 && duplicated.length === 0, lost, duplicated, retired };
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
  console.log(`\ntopics: ${n('topic')}, moves: ${n('move')}, keeps: ${n('keep')}, retires: ${n('retire')}, `
    + `demoted: ${r.demoted.length}, rejected: ${r.errors.length}`);
  if (r.errors.length) console.log(`rejected: ${r.errors.join('; ')}`);
  if (r.skipped.length) console.log(`skipped: ${r.skipped.join('; ')}`);
  if (r.demoted.length) console.log(`demoted by the caps: ${r.demoted.join(', ')}`);
  const sizes = Object.entries(CAPS).map(([f, cap]) => {
    const c = itemChars(after.files[f]);
    return `${f} ${c} / ${cap}${c > cap ? ' (OVER)' : ''}`;
  });
  console.log(`key file chars: ${sizes.join(', ')}`);
  let usage = {};
  try {
    usage = JSON.parse(after.usage || '{}') ?? {};
  } catch {}
  const homeless = Object.keys(CAPS).flatMap((f) => parseMemoryFile(after.files[f]).items.map((x) => x.id))
    .filter((id) => typeof usage[id]?.home !== 'string');
  console.log(`key items without a home: ${homeless.join(', ') || 'none'}`);

  const [was, now] = [idState(before), idState(after)];
  const acc = accounting(was, now);
  if (acc.ok) {
    console.log(`accounting: ok, ${was.live.size} IDs live before; ${now.live.size} live after, `
      + `${acc.retired.length} retired with a reason`);
  } else {
    console.log(`accounting: FAILED; neither live nor retired by this run with a reason: ${acc.lost.join(', ') || 'none'}; `
      + `more copies than before: ${acc.duplicated.join(', ') || 'none'}`);
  }
  return acc.ok;
}

const USAGE_LINE = 'usage: reorganize-slate.mjs <name> [--dry-run] [--save <file>] [--ops <file>]';

function parseArgs(argv) {
  const out = { dry: false, save: null, ops: null, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dry = true;
    else if (a === '--save' || a === '--ops') {
      if (i + 1 >= argv.length) fail(USAGE_LINE);
      out[a.slice(2)] = path.resolve(argv[++i]);
    } else if (a.startsWith('--')) fail(USAGE_LINE);
    else out.names.push(a);
  }
  if (out.names.length !== 1 || (out.ops && out.save)) fail(USAGE_LINE);
  return out;
}

// The op list from a file --dry-run or --save wrote: `{ slate, at, model, ops }`.
async function loadOps(file, real) {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    fail(`can't read ${file} (${e.message})`);
  }
  if (!Array.isArray(saved?.ops)) fail(`no op list in ${file}`);
  if (typeof saved.slate === 'string' && saved.slate !== real) {
    fail(`the ops in ${file} were planned for ${saved.slate}, not ${real}`);
  }
  return saved;
}

// One model run; the op list, or the tool exits with nothing changed.
async function plan(real, before) {
  const prompt = buildPrompt(await fs.readFile(RULES_FILE, 'utf8'), real, before);
  const bin = resolveClaudeBin();
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
  return changes.ops;
}

async function main(argv) {
  const args = parseArgs(argv);
  const [name] = args.names;
  if (!validName(name)) fail(`invalid name ${JSON.stringify(name)}: use a-z0-9 and single hyphens, at most 64 characters`);
  const slate = slateDir(slateHome(), name);
  if (!(await fs.stat(slate).catch(() => null))?.isDirectory()) fail(`no slate at ${slate}`);
  const real = realpathSync(slate);
  const saved = args.ops ? await loadOps(args.ops, real) : null;
  const before = await readState(real);
  console.log(`reorganize ${real}${args.dry ? ' (dry run: the plan is applied to a scratch copy; the slate is unchanged)' : ''}`);

  const ops = saved ? saved.ops : await plan(real, before);
  console.log(`\nops (${ops.length})${saved ? ` from ${args.ops}${saved.at ? `, planned ${saved.at}` : ''}` : ''}:`);
  ops.forEach((o, i) => console.log(describe(o, i)));
  const saveTo = !saved && (args.save ?? (args.dry
    ? path.join(os.tmpdir(), `slate-reorganize-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`) : null));
  if (saveTo) {
    await fs.writeFile(saveTo, `${JSON.stringify({ slate: real, at: new Date().toISOString(), model: MODEL, ops }, null, 2)}\n`);
    console.log(`ops saved to ${saveTo}`);
  }

  const scratch = args.dry ? await scratchCopy(name, before) : null;
  try {
    const target = scratch ? scratch.slate : real;
    const r = await applyChanges(target, ops, APPLY);
    if (!report(before, await readState(target), r, args.dry)) process.exitCode = 1;
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
