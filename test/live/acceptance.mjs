#!/usr/bin/env node
// Live acceptance: a real five-turn `claude -p` session with slate loaded through --plugin-dir.
// Real model calls, so it is opt-in and `npm test` only registers it as skipped:
//   node test/live/acceptance.mjs --live [--out <results.json>]
// Env: SLATE_LIVE_CLAUDE (main-session binary; default CLAUDE_CODE_EXECPATH, else `claude`),
//      SLATE_LIVE_MODEL (main-session model; default sonnet). The curator uses its own default.
// It leaves the temp project and ~/.claude/projects/<slug>/ in place and prints both paths;
// remove them once the results are recorded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSession, turnState } from '../../plugins/slate/scripts/lib/session.mjs';

const argv = process.argv.slice(2);

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN = path.join(REPO, 'plugins', 'slate');
const MODEL = process.env.SLATE_LIVE_MODEL || 'sonnet';
const TURN_TIMEOUT_MS = 15 * 60_000;
const CURATOR_WAIT_MS = 180_000;
const TOOL_RESULT_MAX = 2000;
const LIVE_FILES = ['instructions.md', 'assumptions.md', 'facts.md', 'now.md'];
const MEMORY_FILES = [...LIVE_FILES, 'superseded.md'];
const NPM = /\bnpm\b/;
const PROMPTS = [
  '/slate:init',
  'For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.',
  'Find every file that mentions "TODO(perf)" and summarize the patterns.',
  'Change of plan: this project uses pnpm now.',
  'What command installs lodash? Reply with only the command.',
];
// Outside-the-plugin failures that earn one retry.
const TRANSIENT = /rate.?limit|overloaded|\b(429|500|502|503|529)\b|ECONNRESET|ETIMEDOUT|socket hang up|authenticat|oauth|401|403/i;

const outArg = argv.indexOf('--out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const secs = (ms) => Math.round(ms / 100) / 10;

function claudeBin() {
  if (process.env.SLATE_LIVE_CLAUDE) return process.env.SLATE_LIVE_CLAUDE;
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (exec && path.isAbsolute(exec) && fs.existsSync(exec)) return exec;
  return 'claude';
}

// The parent session's CLAUDE_* / terminal-integration vars must not reach the session under test.
function cleanEnv() {
  const keep = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR'];
  return Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
}

// --- fake repo -------------------------------------------------------------------------------

const PERF = [
  ['src/ui/OrderList.jsx', '  // TODO(perf): memoize this selector; it recomputes on every render'],
  ['src/ui/Dashboard.jsx', '  {/* TODO(perf) virtualize the table once rows exceed 500 */}'],
  ['src/api/users.py', '    # TODO(perf) N+1 query: batch-load users with one SELECT ... IN'],
  ['src/api/orders.py', '    # TODO(perf): paginate; this loads every order into memory'],
  ['src/core/buffer.js', '  /* TODO(perf): avoid copying the buffer on each append */'],
  ['src/core/dedupe.js', '  // TODO(perf) O(n^2) dedupe; switch to a Set'],
  ['src/workers/ingest.go', '\t// TODO(perf) - use a streaming JSON decoder for large payloads'],
  ['db/migrations/0007_orders.sql', '-- TODO(perf): add an index on orders(created_at)'],
  ['public/index.html', '    <!-- TODO(perf): lazy-load the hero image -->'],
  ['config/resolver.yaml', '# TODO(perf): cache DNS lookups for 60s'],
  ['docs/architecture.md', '- TODO(perf): the report job scans the whole table nightly'],
  ['src/utils/format.ts', '  // todo(perf): Intl.NumberFormat is rebuilt per call; hoist it'],
  ['scripts/build.sh', '# TODO(perf, alice): parallelize asset compression'],
  ['src/db/pool.rs', '    // TODO(perf)!! connection pool size is hard-coded to 4'],
];
const DISTRACTORS = [
  '// TODO: tidy this up later',
  '// FIXME(perf) is not the tag we use',
  '// TODO(security): validate the redirect URL',
  '// TODO perf: unclear, revisit',
];
const AREAS = ['src/api', 'src/core', 'src/db', 'src/ui', 'src/utils', 'src/workers', 'lib', 'tests', 'docs', 'config'];
const EXT = { 'src/api': 'py', 'src/core': 'js', 'src/db': 'rs', 'src/ui': 'jsx', 'src/utils': 'ts', 'src/workers': 'go', lib: 'js', tests: 'js', docs: 'md', config: 'yaml' };

function filler(file, n, extra = []) {
  const lines = [`// ${file}`, ''];
  for (let i = 1; i <= n; i++) {
    lines.push(`function step${i}(input) {`, `  const value${i} = input * ${i} + ${n};`, `  return value${i} % 97;`, '}', '');
    if (i === Math.floor(n / 2)) lines.push(...extra);
  }
  return `${lines.join('\n')}\n`;
}

export function buildRepo(root) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('package.json', `${JSON.stringify({ name: 'acme-shop', version: '1.4.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`);
  write('README.md', '# acme-shop\n\nA demo storefront.\n');
  let count = 2;
  for (const [rel, line] of PERF) {
    write(rel, filler(rel, 12, [line]));
    count++;
  }
  for (let i = 0; count < 200; i++, count++) {
    const area = AREAS[i % AREAS.length];
    const rel = `${area}/module_${String(i).padStart(3, '0')}.${EXT[area]}`;
    write(rel, filler(rel, 8 + (i % 7), i % 9 === 0 ? [DISTRACTORS[i % DISTRACTORS.length]] : []));
  }
  return count;
}

// --- processes -------------------------------------------------------------------------------

function run(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = now();
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e.message}`, ms: now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: now() - started });
    });
  });
}

const execText = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { maxBuffer: 64 << 20 }, (e, out) => resolve(e ? '' : out)));

// Samples `ps` for this session's curator (node curate.mjs <dir> …) and records what its children
// run: argv[0], the executable file (lsof txt), and --model.
function curatorSampler(sessionId) {
  const seen = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = (await execText('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='])).split('\n').map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
        return m && { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
      }).filter(Boolean);
      const curators = new Set(rows.filter((r) => r.command.includes('curate.mjs') && r.command.includes(sessionId)).map((r) => r.pid));
      for (const r of rows) {
        if (!curators.has(r.ppid) || seen.has(r.pid)) continue;
        const exe = (await execText('lsof', ['-p', String(r.pid), '-a', '-d', 'txt', '-Fn']))
          .split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null;
        seen.set(r.pid, {
          at: new Date().toISOString(),
          argv0: r.command.split(' ')[0],
          exe,
          model: /--model (\S+)/.exec(r.command)?.[1] ?? null,
          print: / -p /.test(` ${r.command} `),
        });
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 300);
  return { stop: () => clearInterval(timer), seen: () => [...seen.values()] };
}

// --- session folder --------------------------------------------------------------------------

const exists = (p) => fs.existsSync(p);

async function curatorSettled(dir) {
  if (exists(path.join(dir, 'curator.lock'))) return false;
  const session = await readSession(dir);
  let curated = { turn: 0, size: 0 };
  try {
    curated = JSON.parse(fs.readFileSync(path.join(dir, 'curated.json'), 'utf8'));
  } catch {}
  if (curated.turn !== session.turn) return false;
  if (session.turn === 0) return true;
  const st = await turnState(dir, session.turn);
  return !st || st.size === curated.size; // a grown turn file (continuation) is re-curated
}

// Polls until the curator is done with every turn; the condition must hold on two polls in a row,
// because a just-spawned curator may not hold the lock yet.
async function waitCurator(dir) {
  const started = now();
  let streak = 0;
  while (now() - started < CURATOR_WAIT_MS) {
    streak = (await curatorSettled(dir)) ? streak + 1 : 0;
    if (streak >= 2) return { ok: true, ms: now() - started };
    await sleep(750);
  }
  return { ok: false, ms: now() - started };
}

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

// --- transcript ------------------------------------------------------------------------------

function transcriptPath(project, sessionId) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const direct = path.join(projects, project.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (exists(direct)) return direct;
  for (const d of fs.readdirSync(projects)) {
    const p = path.join(projects, d, `${sessionId}.jsonl`);
    if (exists(p)) return p;
  }
  return direct;
}

const lineCount = (p) => (readText(p) ?? '').split('\n').filter(Boolean).length;
const entries = (p) => (readText(p) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const blockText = (content) =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : typeof b === 'string' ? b : '')).join('')
      : '';

function analyse(all, ranges) {
  const main = all.map((e, i) => ({ e, i })).filter(({ e }) => !e.isSidechain);
  const turnOf = (i) => ranges.findIndex(([a, b]) => i >= a && i < b) + 1;
  const toolUses = new Map();
  const agentCalls = [];
  const toolResults = [];
  const hookContext = [];
  const notifications = [];
  for (const { e, i } of main) {
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        toolUses.set(b.id, b.name);
        if (b.name === 'Agent' || b.name === 'Task') agentCalls.push({ turn: turnOf(i), subagent_type: b.input?.subagent_type ?? null, input: b.input });
      }
    }
    if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        toolResults.push({ turn: turnOf(i), tool: toolUses.get(b.tool_use_id) ?? '?', chars: blockText(b.content).length });
      }
    }
    if (e.type === 'user' && blockText(content).startsWith('<task-notification>')) {
      notifications.push({ turn: turnOf(i), chars: blockText(content).length });
    }
    if (e.type === 'attachment' && e.attachment?.type === 'hook_additional_context') {
      hookContext.push({ turn: turnOf(i), event: e.attachment.hookEvent, text: (e.attachment.content ?? []).join('\n') });
    }
  }
  return { agentCalls, toolResults, hookContext, notifications };
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  const bin = claudeBin();
  const env = cleanEnv();
  const version = (await run(bin, ['--version'], { cwd: os.tmpdir(), env, timeoutMs: 30_000 })).stdout.trim();
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slate-acc-')));
  const fileCount = buildRepo(project);
  const sessionId = randomUUID();
  const dir = path.join(project, '.slate', sessionId);
  const transcript = () => transcriptPath(project, sessionId);
  const out = outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.join(os.tmpdir(), `slate-acc-results-${sessionId}.json`);
  console.log(`project ${project} (${fileCount} files)\nsession ${sessionId}\nclaude ${bin} (${version}), main model ${MODEL}`);

  const sampler = curatorSampler(sessionId);
  const turns = [];
  const ranges = [];
  for (let t = 0; t < PROMPTS.length; t++) {
    const args = [
      '-p', PROMPTS[t],
      ...(t === 0 ? ['--session-id', sessionId] : ['--resume', sessionId]),
      '--plugin-dir', PLUGIN,
      '--model', MODEL,
      '--setting-sources', 'project,local',
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json',
    ];
    const before = lineCount(transcript());
    let r;
    let retried = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      r = await run(bin, args, { cwd: project, env, timeoutMs: TURN_TIMEOUT_MS });
      let json = null;
      try {
        json = JSON.parse(r.stdout);
      } catch {}
      r.json = json;
      const failed = r.code !== 0 || !json || json.is_error;
      const grew = lineCount(transcript()) > before;
      if (failed && attempt === 1 && !grew && TRANSIENT.test(`${r.stderr} ${json?.result ?? ''}`)) {
        retried = true;
        await sleep(30_000);
        continue;
      }
      break;
    }
    ranges.push([before, lineCount(transcript())]);
    const turn = {
      n: t + 1,
      prompt: PROMPTS[t],
      exit: r.code,
      retried,
      wallSec: secs(r.ms),
      result: r.json?.result ?? null,
      isError: r.json?.is_error ?? null,
      costUsd: r.json?.total_cost_usd ?? null,
      numTurns: r.json?.num_turns ?? null,
      stderr: r.stderr.trim().slice(-500),
    };
    turns.push(turn);
    console.log(`turn ${turn.n}: exit ${r.code}, ${turn.wallSec}s, $${turn.costUsd}: ${String(turn.result).slice(0, 160).replace(/\n/g, ' ')}`);
    if (!exists(path.join(dir, 'session.json'))) {
      console.log(`no session folder after turn ${turn.n}; stopping`);
      break;
    }
    const w = await waitCurator(dir);
    turn.curatorOk = w.ok;
    turn.curatorSec = secs(w.ms);
    console.log(`  curator ${w.ok ? 'settled' : 'NOT settled'} after ${turn.curatorSec}s`);
  }
  await sleep(1000);
  sampler.stop();

  // --- assertions ---
  const tp = transcript();
  const all = entries(tp);
  const a = analyse(all, ranges);
  const mem = Object.fromEntries(MEMORY_FILES.map((f) => [f, readText(path.join(dir, f))]));
  const live = LIVE_FILES.map((f) => mem[f] ?? '').join('\n');
  const log = readText(path.join(dir, 'curator.log')) ?? '';
  const badLog = log.split('\n').filter((l) => /^\S+ t\d+ (restored|error)\b/.test(l));
  const turn5 = turns[4]?.result ?? '';
  const offload3 = a.agentCalls.filter((c) => c.turn === 3 && c.subagent_type === 'slate:offload');
  const bigResults = a.toolResults.filter((r) => r.chars > TOOL_RESULT_MAX);
  const lateAgents = a.agentCalls.filter((c) => c.turn >= 4);
  const npmAgents = lateAgents.filter((c) => NPM.test(JSON.stringify(c.input)));
  const checks = [
    ['turn 3 used an Agent call with slate:offload', offload3.length > 0, `${offload3.length} slate:offload call(s) in turn 3; all Agent calls: ${a.agentCalls.map((c) => `t${c.turn} ${c.subagent_type}`).join(', ') || 'none'}`],
    [`no main-thread tool_result over ${TOOL_RESULT_MAX} chars`, bigResults.length === 0, `max ${Math.max(0, ...a.toolResults.map((r) => r.chars))} chars over ${a.toolResults.length} results${bigResults.length ? `; over: ${JSON.stringify(bigResults)}` : ''}`],
    ['no Agent input from turn 4 on matches /\\bnpm\\b/', npmAgents.length === 0, `${lateAgents.length} Agent call(s) from turn 4 on, ${npmAgents.length} mention npm`],
    ['live memory files do not match /\\bnpm\\b/', !NPM.test(live), LIVE_FILES.filter((f) => NPM.test(mem[f] ?? '')).join(', ') || 'none match'],
    ['superseded.md matches /\\bnpm\\b/', NPM.test(mem['superseded.md'] ?? ''), ''],
    ['turn-5 answer contains pnpm', /pnpm/.test(turn5), JSON.stringify(turn5)],
    ['stg-7.internal is in live memory', live.includes('stg-7.internal'), LIVE_FILES.filter((f) => (mem[f] ?? '').includes('stg-7.internal')).join(', ') || 'absent'],
    ['curator.log has no restored or error lines', badLog.length === 0, badLog.join(' | ')],
  ].map(([name, pass, detail]) => ({ name, pass, detail }));

  const results = {
    project, sessionId, transcript: tp, claude: { bin, version }, model: MODEL, fileCount,
    turns, checks, agentCalls: a.agentCalls, toolResults: a.toolResults, notifications: a.notifications,
    hookContext: a.hookContext.map((h) => ({ ...h, text: h.text.slice(0, 600) })),
    curatorProcesses: sampler.seen(),
    memory: mem,
    curatorLog: log,
    session: readText(path.join(dir, 'session.json')),
    curated: readText(path.join(dir, 'curated.json')),
    conversation: fs.existsSync(path.join(dir, 'conversation')) ? fs.readdirSync(path.join(dir, 'conversation')) : [],
    reports: fs.existsSync(path.join(dir, 'reports')) ? fs.readdirSync(path.join(dir, 'reports')) : [],
  };
  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  console.log('\nchecks:');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(`\ncurator processes: ${JSON.stringify(results.curatorProcesses)}`);
  console.log(`results: ${out}\nleft in place: ${project}\n               ${path.dirname(tp)}`);
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
}

if (argv.includes('--live')) {
  await main();
} else {
  const why = 'opt-in, real model calls: node test/live/acceptance.mjs --live';
  if (process.env.NODE_TEST_CONTEXT) (await import('node:test')).test('live acceptance', { skip: why });
  else console.log(`skipped (${why})`);
}
