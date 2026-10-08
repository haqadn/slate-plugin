#!/usr/bin/env node
// Live acceptance: a real six-turn `claude -p` session with slate loaded through --plugin-dir.
// Real model calls, so it is opt-in and `npm test` only registers it as skipped:
//   node test/live/acceptance.mjs --live [--real-settings] [--out <results.json>]
// Default: user settings, plugins and hooks kept out (--setting-sources project,local) and
// --permission-mode acceptEdits. --real-settings: turns 1-3 only, with neither flag, so the
// user's own plugins, hooks, CLAUDE.md and permission rules load.
// A throwaway probe plugin is loaded alongside slate to record what SubagentStop hooks receive.
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
import { HARNESS_PREFIXES } from '../../plugins/slate/scripts/hook.mjs';

const argv = process.argv.slice(2);

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN = path.join(REPO, 'plugins', 'slate');
const MODEL = process.env.SLATE_LIVE_MODEL || 'sonnet';
const TURN_TIMEOUT_MS = 15 * 60_000;
const CURATOR_WAIT_MS = 180_000;
const MAIN_THREAD_MAX = 2000; // chars, per tool_result and per task-notification
const LIVE_FILES = ['instructions.md', 'assumptions.md', 'facts.md', 'now.md'];
const MEMORY_FILES = [...LIVE_FILES, 'superseded.md'];
const NPM = /\bnpm\b/;
// An npm command, as opposed to npm named as a search term or in a true fact ("no npm usage found").
const NPM_CMD = /\bnpm\s+(i|install|add|ci|run)\b/i;
const REMINDER = 'slate: offload heavy reads to slate:offload; reply briefly.';
const REAL = argv.includes('--real-settings');
const PROMPTS = [
  '/slate:init',
  'For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.',
  'Find every file that mentions "TODO(perf)" and summarize the patterns.',
  'Change of plan: this project uses pnpm now.',
  'What command installs lodash? Reply with only the command.',
  'Research this repo, then draft a short "Install" section for CONTRIBUTING.md. Write it to CONTRIBUTING.md.',
].slice(0, REAL ? 3 : 6);
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
  const pkg = (o) => `${JSON.stringify(o, null, 2)}\n`;
  // Install commands for turn 6 to find. None uses npm: a project fact naming npm would
  // legitimately land in live memory and confound the "no npm in live memory" check.
  write('package.json', pkg({ name: 'acme-shop', version: '1.4.0', private: true, scripts: { test: 'node --test', setup: 'sh scripts/setup.sh' } }));
  write('packages/web/package.json', pkg({ name: '@acme/web', private: true, scripts: { bootstrap: 'pnpm install', build: 'vite build', postinstall: 'node ../../scripts/patch-deps.js' } }));
  write('scripts/setup.sh', '#!/bin/sh\nset -e\ncorepack enable\npnpm install --frozen-lockfile\n');
  write('Dockerfile', 'FROM node:24-slim\nWORKDIR /app\nCOPY . .\nRUN corepack enable && pnpm install --prod --frozen-lockfile\nCMD ["node", "lib/server.js"]\n');
  write('README.md', '# acme-shop\n\nA demo storefront.\n');
  let count = 5;
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

export function analyse(all, ranges) {
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
    // A subagent's return reaches the main thread as a <task-notification> (background agent) or,
    // where the hand-back tool is on, as an <agent-message> user message. Both count.
    // Harness messages (hook.mjs HARNESS_PREFIXES): a background agent's <task-notification>, a
    // hand-back <agent-message>, and so on. The transcript may put one intro line before the tag.
    const text = e.type === 'user' ? blockText(content) : '';
    const tagged = text.replace(/^[^\n<\[]*\n/, '');
    const prefix = HARNESS_PREFIXES.find((p) => text.startsWith(p) || tagged.startsWith(p));
    if (prefix) {
      const kind = prefix.replace(/^[<[]/, '');
      const result = kind === 'task-notification' ? /<result>([\s\S]*?)<\/result>/.exec(text)?.[1] ?? '' : text;
      notifications.push({ turn: turnOf(i), kind, chars: text.length, resultChars: result.length, result });
    }
    if (e.type === 'attachment' && e.attachment?.type === 'hook_additional_context') {
      hookContext.push({ turn: turnOf(i), event: e.attachment.hookEvent, text: (e.attachment.content ?? []).join('\n') });
    }
  }
  return { agentCalls, toolResults, hookContext, notifications };
}

// The subagents' tool calls: file writes (Write/Edit) with their outcome, and every call of any tool
// that was denied (in -p a denial is an error result, never a prompt).
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export function subagentTools(transcriptFile, sessionId) {
  const dir = path.join(path.dirname(transcriptFile), sessionId, 'subagents');
  const writes = [];
  const denials = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {}
  for (const f of files) {
    const calls = new Map();
    for (const e of entries(path.join(dir, f))) {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_use') {
          calls.set(b.id, { agent: f, tool: b.name, file: b.input?.file_path ?? null, command: b.input?.command?.slice(0, 120) ?? null, error: null, result: null });
        }
        if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
          const c = calls.get(b.tool_use_id);
          c.error = Boolean(b.is_error);
          c.result = blockText(b.content).slice(0, 300);
        }
      }
    }
    for (const c of calls.values()) {
      if (WRITE_TOOLS.includes(c.tool)) writes.push(c);
      if (c.error && /permission|denied/i.test(c.result ?? '')) denials.push(c);
    }
  }
  return { writes, denials };
}

// --- SubagentStop probe ---------------------------------------------------------------------

// A throwaway second plugin (loaded with its own --plugin-dir) that records what every SubagentStop
// hook receives: the field names, agent type, stop_hook_active, session_id and the return's length.
export function buildProbe(root) {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'slate-probe', version: '0.0.0', description: 'live-test probe' })}\n`);
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/record.mjs"', timeout: 10 }] }] } })}\n`);
  fs.writeFileSync(path.join(root, 'record.mjs'), `import fs from 'node:fs';
let t = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) t += c;
const i = JSON.parse(t);
const m = i.last_assistant_message;
fs.appendFileSync(new URL('./subagent-stop.jsonl', import.meta.url), JSON.stringify({
  at: new Date().toISOString(), keys: Object.keys(i).sort(), agent_type: i.agent_type, agent_id: i.agent_id,
  stop_hook_active: i.stop_hook_active, session_id: i.session_id, chars: typeof m === 'string' ? [...m].length : null,
}) + '\\n');
`);
  return path.join(root, 'subagent-stop.jsonl');
}

// Each slate:offload stop the probe saw, whether it was over the limit and whether it was sent back,
// plus how many times each agent was sent back. A send-back is persisted in the agent's transcript
// as one hook_blocking_error attachment (its text also appears in a "Stop hook feedback" message,
// so count attachments, not text matches); a block also makes the agent stop again with
// stop_hook_active set.
export function offloadBlocks(offloadStops, subagentsDir) {
  const blockEvents = (id) => entries(path.join(subagentsDir, `agent-${id}.jsonl`))
    .filter((e) => e.type === 'attachment' && e.attachment?.type === 'hook_blocking_error'
      && e.attachment.hookEvent === 'SubagentStop'
      && /^Return is \d+ chars\./.test(String(e.attachment.blockingError?.blockingError ?? '')))
    .map((e) => e.attachment.blockingError.blockingError);
  const blocks = offloadStops.map((p, i) => ({
    ...p,
    // No last_assistant_message (e.g. the agent ended with a hand-back tool call): the return
    // was invisible to the cap, so it counts as over and unblocked.
    over: p.stop_hook_active !== true && (p.chars === null || p.chars > 800),
    blocked: blockEvents(p.agent_id).some((t) => t.startsWith(`Return is ${p.chars} chars.`))
      || offloadStops.slice(i + 1).some((q) => q.agent_id === p.agent_id && q.stop_hook_active === true),
  }));
  const ids = [...new Set(offloadStops.map((p) => p.agent_id))];
  const blockCounts = ids.map((id) => blockEvents(id).length);
  return { blocks, blockCounts };
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
  const probeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slate-probe-')));
  const probeLog = buildProbe(probeDir);
  console.log(`project ${project} (${fileCount} files)\nsession ${sessionId}\nclaude ${bin} (${version}), main model ${MODEL}, ${REAL ? 'real settings' : 'isolated settings'}`);

  const sampler = curatorSampler(sessionId);
  const turns = [];
  const ranges = [];
  for (let t = 0; t < PROMPTS.length; t++) {
    const args = [
      '-p', PROMPTS[t],
      ...(t === 0 ? ['--session-id', sessionId] : ['--resume', sessionId]),
      '--plugin-dir', PLUGIN,
      '--plugin-dir', probeDir,
      '--model', MODEL,
      ...(REAL ? [] : ['--setting-sources', 'project,local', '--permission-mode', 'acceptEdits']),
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
      permissionDenials: r.json?.permission_denials ?? null,
      stderr: r.stderr.trim().slice(-500),
    };
    turns.push(turn);
    turn.resultChars = (turn.result ?? '').length;
    console.log(`turn ${turn.n}: exit ${r.code}, ${turn.wallSec}s, $${turn.costUsd}, reply ${turn.resultChars} chars: ${String(turn.result).slice(0, 160).replace(/\n/g, ' ')}`);
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
  const badLog = log.split('\n').filter((l) => /\b(restored|error)\b/i.test(l));
  const slateTurns = exists(path.join(dir, 'session.json')) ? (await readSession(dir)).turn : 0;
  const okMissing = Array.from({ length: slateTurns }, (_, i) => i + 1).filter((t) => !new RegExp(`^\\S+ t${t} ok:`, 'm').test(log));
  const turn5 = turns[4]?.result ?? '';
  const offload3 = a.agentCalls.filter((c) => c.turn === 3 && c.subagent_type === 'slate:offload');
  const bigResults = a.toolResults.filter((r) => r.chars > MAIN_THREAD_MAX);
  const bigNotes = a.notifications.filter((n) => n.chars > MAIN_THREAD_MAX);
  const afterSwitch = a.agentCalls.filter((c) => c.turn >= 5);
  const lateAgents = a.agentCalls.filter((c) => c.turn >= 4);
  const npmAgents = lateAgents.filter((c) => NPM_CMD.test(JSON.stringify(c.input)));
  const npmRules = ['instructions.md', 'assumptions.md', 'now.md'].filter((f) => NPM.test(mem[f] ?? ''));
  const contributing = readText(path.join(project, 'CONTRIBUTING.md'));
  const probes = (readText(probeLog) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const offloadStops = probes.filter((p) => p.agent_type === 'slate:offload');
  const SHAPE = ['agent_type', 'last_assistant_message', 'stop_hook_active', 'session_id', 'agent_id'];
  const { blocks, blockCounts } = offloadBlocks(offloadStops, path.join(path.dirname(tp), sessionId, 'subagents'));
  const userTurns = turns.slice(1).map((t) => t.n);
  const noChangeLine = userTurns.filter((n) => !a.hookContext.some((h) => h.turn === n && h.event === 'UserPromptSubmit' && h.text.includes(REMINDER)));
  const { writes, denials } = subagentTools(tp, sessionId);
  const reports = exists(path.join(dir, 'reports')) ? fs.readdirSync(path.join(dir, 'reports')) : [];
  const initReply = turns[0]?.result ?? '';
  const BOTH = ['full', 'real'];
  const FULL = ['full'];
  const checks = [
    [BOTH, '/slate:init created the folder and replied in one line', exists(path.join(dir, 'session.json')) && initReply.trim() !== '' && !initReply.trim().includes('\n'), JSON.stringify(initReply), ['real']],
    [BOTH, 'turn 3 used an Agent call with slate:offload', offload3.length > 0, `${offload3.length} slate:offload call(s) in turn 3; all Agent calls: ${a.agentCalls.map((c) => `t${c.turn} ${c.subagent_type}`).join(', ') || 'none'}`],
    [BOTH, `no main-thread tool_result over ${MAIN_THREAD_MAX} chars`, bigResults.length === 0, `max ${Math.max(0, ...a.toolResults.map((r) => r.chars))} chars over ${a.toolResults.length} results${bigResults.length ? `; over: ${JSON.stringify(bigResults)}` : ''}`],
    [BOTH, `no main-thread harness message (task-notification, agent-message, …) over ${MAIN_THREAD_MAX} chars`, bigNotes.length === 0, `${a.notifications.map((n) => `t${n.turn} ${n.kind} ${n.chars} chars (result ${n.resultChars})`).join(', ') || 'none'}`],
    [FULL, 'at least one Agent call after turn 4', afterSwitch.length > 0, `${afterSwitch.length}: ${afterSwitch.map((c) => `t${c.turn} ${c.subagent_type}`).join(', ') || 'none'}`],
    [FULL, 'no Agent brief from turn 4 on contains an npm command', npmAgents.length === 0, `${lateAgents.length} Agent call(s) from turn 4 on, ${npmAgents.length} with ${NPM_CMD}`],
    [FULL, 'no npm in instructions.md, assumptions.md or now.md (facts exempt)', npmRules.length === 0, npmRules.join(', ') || 'none match'],
    [FULL, 'superseded.md matches /\\bnpm\\b/', NPM.test(mem['superseded.md'] ?? ''), ''],
    [FULL, 'CONTRIBUTING.md, if written, uses pnpm and has no npm command', contributing === null || (/\bpnpm\b/.test(contributing) && !NPM_CMD.test(contributing)), contributing === null ? 'not written' : `${contributing.length} chars, pnpm ${/\bpnpm\b/.test(contributing)}, npm command ${NPM_CMD.test(contributing)}`],
    [FULL, 'turn-5 answer contains pnpm', /pnpm/.test(turn5), JSON.stringify(turn5)],
    [BOTH, 'stg-7.internal is in live memory', live.includes('stg-7.internal'), LIVE_FILES.filter((f) => (mem[f] ?? '').includes('stg-7.internal')).join(', ') || 'absent'],
    [BOTH, 'curator.log has no line matching /\\b(restored|error)\\b/i', badLog.length === 0, badLog.join(' | ')],
    [BOTH, 'every user turn got the slate change line', noChangeLine.length === 0, noChangeLine.length ? `missing on turn(s) ${noChangeLine.join(', ')}` : `turns ${userTurns.join(', ')}`],
    [BOTH, 'slate counted only user prompts as turns', slateTurns === userTurns.length, `${slateTurns} slate turn(s) for ${userTurns.length} user prompt(s); harness messages seen: ${a.notifications.map((n) => `t${n.turn} ${n.kind}`).join(', ') || 'none'}`],
    [BOTH, 'curator.log has an ok line for every slate turn', slateTurns > 0 && okMissing.length === 0, `${slateTurns} slate turn(s)${okMissing.length ? `; no ok for t${okMissing.join(', t')}` : ''}`],
    [BOTH, 'offload report written, no subagent Write/Edit failed', reports.length > 0 && writes.every((w) => !w.error), `reports: ${reports.join(', ') || 'none'}; writes: ${writes.map((w) => `${w.tool} ${path.basename(w.file ?? '?')} ${w.error ? `ERROR ${w.result}` : 'ok'}`).join('; ') || 'none'}; denied (any tool): ${denials.map((d) => `${d.tool} ${d.command ?? d.file ?? ''}`).join('; ') || 'none'}`],
    [BOTH, 'SubagentStop input carries agent_type, last_assistant_message, stop_hook_active, agent_id and the main session_id', offloadStops.length > 0 && offloadStops.every((p) => SHAPE.every((k) => p.keys.includes(k)) && p.session_id === sessionId), `${probes.length} SubagentStop(s), ${offloadStops.length} slate:offload; keys: ${[...new Set(probes.flatMap((p) => p.keys))].join(',')}`],
    [BOTH, 'every slate:offload return over 800 chars was sent back, at most once per agent', blocks.every((b) => !b.over || b.blocked) && blockCounts.every((n) => n <= 1), blocks.map((b) => `${String(b.agent_id ?? "?").slice(0, 6)} ${b.chars === null ? 'no last_assistant_message' : `${b.chars} chars`}${b.stop_hook_active ? ' (stop_hook_active)' : ''}${b.over ? (b.blocked ? ' blocked' : ' NOT blocked') : ''}`).join('; ') || 'no offload stops'],
  ].filter(([profiles]) => profiles.includes(REAL ? 'real' : 'full'))
    .map(([, name, pass, detail, softIn]) => ({ name, pass, detail, soft: Boolean(softIn?.includes(REAL ? 'real' : 'full')) }));

  const results = {
    profile: REAL ? 'real-settings' : 'isolated', project, sessionId, transcript: tp, claude: { bin, version }, model: MODEL, fileCount,
    turns, checks, subagentStops: probes, contributing, agentCalls: a.agentCalls, toolResults: a.toolResults, notifications: a.notifications, subagentWrites: writes, subagentDenials: denials,
    hookContext: a.hookContext.map((h) => ({ ...h, text: h.text.slice(0, 600) })),
    curatorProcesses: sampler.seen(),
    memory: mem,
    curatorLog: log,
    session: readText(path.join(dir, 'session.json')),
    curated: readText(path.join(dir, 'curated.json')),
    conversation: fs.existsSync(path.join(dir, 'conversation')) ? fs.readdirSync(path.join(dir, 'conversation')) : [],
    reports: Object.fromEntries(reports.map((f) => [f, readText(path.join(dir, 'reports', f))])),
  };
  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  console.log('\nchecks:');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : c.soft ? 'INFO' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(`\ncurator processes: ${JSON.stringify(results.curatorProcesses)}`);
  console.log(`results: ${out}\nleft in place: ${project}\n               ${path.dirname(tp)}`);
  console.log(`left in place: ${probeDir}`);
  process.exitCode = checks.every((c) => c.pass || c.soft) ? 0 : 1;
}

if (argv.includes('--live')) {
  await main();
} else {
  const why = 'opt-in, real model calls: node test/live/acceptance.mjs --live';
  if (process.env.NODE_TEST_CONTEXT) (await import('node:test')).test('live acceptance', { skip: why });
  else console.log(`skipped (${why})`);
}
