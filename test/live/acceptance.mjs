#!/usr/bin/env node
// Live acceptance: two real `claude -p` sessions, A and B, linked to one shared slate and run in
// parallel, with slate loaded through --plugin-dir. Real model calls, so it is opt-in and
// `npm test` only registers it as skipped:
//   node test/live/acceptance.mjs --live [--out <results.json>]
//   node test/live/acceptance.mjs --recheck <results.json> [--out <file>]   (saved run, no model calls)
// Both sessions run with --setting-sources project,local (the user's settings, plugins and hooks
// stay out) and no --permission-mode, so in the default permission mode. Every turn's stream-json
// init must list exactly one slate plugin, this checkout's, and the default mode; else the run stops.
// SLATE_HOME is a fresh temp dir holding the pre-created slate `accept`, so `/slate:link accept`
// links without a question. A works in a fake repo: link, "use npm", a heavy search, "pnpm now",
// "what installs lodash?", one -p run per turn. B works in another folder: link in its own -p run,
// then three short turns in one long-lived stream-json session, each started on one of A's events
// so B's curators overlap A's.
// A throwaway probe plugin is loaded alongside slate to record what SubagentStop and PreToolUse
// hooks receive. The curator runs the real binary through a recorder (SLATE_CLAUDE_BIN) that keeps
// each change list, so the run can check what B's "!!" turn marked relevant. Once everything has
// settled, A is resumed for one more short turn, a session started after the run, to check that its
// memory block lists the topics.
// Env: SLATE_LIVE_CLAUDE (main-session binary; default CLAUDE_CODE_EXECPATH, else `claude`),
//      SLATE_LIVE_MODEL (main-session model; default sonnet). The curator uses its own default.
// It leaves the temp folders and ~/.claude/projects/<slug>/ folders in place and prints them;
// remove them once the results are recorded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSession, turnState } from '../../plugins/slate/scripts/lib/session.mjs';
import { createSlate } from '../../plugins/slate/scripts/lib/slate.mjs';
import { parseMemoryFile } from '../../plugins/slate/scripts/lib/items.mjs';
import { HARNESS_PREFIXES, HANDBACK_TOOLS } from '../../plugins/slate/scripts/hook.mjs';

const argv = process.argv.slice(2);

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN = path.join(REPO, 'plugins', 'slate');
const MODEL = process.env.SLATE_LIVE_MODEL || 'sonnet';
const TURN_TIMEOUT_MS = 15 * 60_000;
const CURATOR_WAIT_MS = 180_000;
const MAIN_THREAD_MAX = 2000; // chars, per tool_result and per task-notification
const SHARED_FILES = ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md'];
const ITEM_FILES = ['instructions.md', 'assumptions.md', 'facts.md'];
const NPM = /\bnpm\b/;
// An npm command, as opposed to npm named as a search term or in a true fact ("no npm usage found").
const NPM_CMD = /\bnpm\s+(i|install|add|ci|run)\b/i;
const REMINDER = 'slate: offload heavy reads to slate:offload; reply briefly.';
const SLATE = 'accept';
const LINK = `/slate:link ${SLATE}`;
const A_PROMPTS = [
  LINK,
  'For this project, always give package-manager commands using npm. Also: the staging host is stg-7.internal.',
  'Find every file that mentions "TODO(perf)" and summarize the patterns.',
  'Change of plan: this project uses pnpm now.',
  'What command installs lodash? Reply with only the command.',
];
// B's turns 2-4 start on A's events: right after A's turn 2 (its curator running), right after
// A's turn 3 (curator running, report written), and once A's turn 4 is curated (with A's turn 5).
// B isn't told the report's name: it finds it the way a real peer would.
const B_PROMPTS = [
  LINK,
  'For this topic, release branches are always named release/<version>; the current one is release/2.4. Reply in one line.',
  'Another session on this slate wrote a TODO(perf) report. Which file does it mark "!!"? Reply in one line.',
  'Which package manager does this topic use? Reply in one line.',
];
// Outside-the-plugin failures that earn one retry.
const TRANSIENT = /rate.?limit|overloaded|\b(429|500|502|503|529)\b|ECONNRESET|ETIMEDOUT|socket hang up|authenticat|oauth|401|403/i;
// A denial in -p is an error result: "Permission to use … denied", "… was blocked. For security …",
// "… requires approval".
const DENIED = /permission|denied|haven't granted|was blocked|requires approval/i;

const outArg = argv.indexOf('--out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const secs = (ms) => Math.round(ms / 100) / 10;
const iso = (ms) => new Date(ms).toISOString();

function claudeBin() {
  if (process.env.SLATE_LIVE_CLAUDE) return process.env.SLATE_LIVE_CLAUDE;
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (exec && path.isAbsolute(exec) && fs.existsSync(exec)) return exec;
  return 'claude';
}

// The parent session's CLAUDE_* / terminal-integration vars must not reach the sessions under test.
// SLATE_HOME reaches the hooks, the skill's commands and the curator through the session's env.
function cleanEnv(home, curatorBin) {
  const keep = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR'];
  return {
    ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    SLATE_HOME: home,
    ...(curatorBin && { SLATE_CLAUDE_BIN: curatorBin }),
  };
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
  // Install commands to find. None uses npm: a project fact naming npm would legitimately land
  // in live memory and confound the "no npm in live memory" check.
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

// Every file and folder under root (dotfiles too), with each file's size and hash.
export function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(p);
      } else {
        const buf = fs.readFileSync(p);
        out[rel] = `${buf.length}:${createHash('sha1').update(buf).digest('hex')}`;
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

export function snapshotDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].sort().flatMap((k) => {
    if (!(k in before)) return [`+${k}`];
    if (!(k in after)) return [`-${k}`];
    return before[k] === after[k] ? [] : [`~${k}`];
  });
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

// A long-lived `claude -p --input-format stream-json` session: SessionStart fires once at spawn,
// then each message sent is one turn (its own init, UserPromptSubmit, Stop and result messages).
// Exits when stdin closes.
function startStream(bin, args, { cwd, env }) {
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const st = { results: [], inits: [], lastOut: now(), stderr: '', code: null };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    st.lastOut = now();
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m?.type === 'system' && m.subtype === 'init') st.inits.push(m);
      if (m?.type === 'result') st.results.push({ ...m, at: now() });
    }
  });
  child.stderr.on('data', (d) => (st.stderr = (st.stderr + d).slice(-2000)));
  st.exit = new Promise((r) => child.on('close', (code) => r((st.code = code))));
  st.send = (text, sessionId) => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId })}\n`);
  st.close = async (ms) => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    await st.exit;
    clearTimeout(timer);
  };
  return st;
}

async function until(pred, ms, every = 500) {
  const end = now() + ms;
  while (now() < end) {
    if (await pred()) return true;
    await sleep(every);
  }
  return false;
}

// stream-json (--verbose): the additionalContext each `event` hook returned, from its hook_response.
export function hookContexts(stdout, event) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== 'system' || m.subtype !== 'hook_response' || m.hook_event !== event) continue;
    try {
      const ctx = JSON.parse(m.output)?.hookSpecificOutput?.additionalContext;
      if (typeof ctx === 'string') out.push(ctx);
    } catch {}
  }
  return out;
}

// stream-json: the init message (plugins, permission mode) and the final result message.
export function parseStream(stdout) {
  let init = null;
  let result = null;
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type === 'system' && m.subtype === 'init' && !init) init = m;
    if (m?.type === 'result') result = m;
  }
  return { init, result };
}

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// The run is only meaningful with this checkout's slate alone (the installed plugin runs older
// code from another folder) and in the default permission mode.
export function pluginGuard(init, pluginDir = PLUGIN) {
  const plugins = Array.isArray(init?.plugins) ? init.plugins : null;
  if (!plugins) return { ok: false, why: 'no plugin list in the stream-json init message', slates: [], mode: init?.permissionMode ?? null };
  const label = (p) => (typeof p === 'string' ? p : String(p?.name ?? ''));
  const slates = plugins.filter((p) => /^slate(@|$)/.test(label(p)))
    .map((p) => ({ name: label(p), path: typeof p === 'string' ? null : p.path ?? null }));
  const mode = init.permissionMode ?? null;
  const ours = slates.length === 1 && (slates[0].path === null || realOr(slates[0].path) === realOr(pluginDir));
  const why = !ours ? `slate plugins loaded: ${JSON.stringify(slates)}` : mode !== 'default' ? `permission mode ${mode}` : null;
  return { ok: why === null, why, slates, mode };
}

const execText = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { maxBuffer: 64 << 20 }, (e, out) => resolve(e ? '' : out)));

// Samples `ps` every 300 ms for curators under `home` (node curate.mjs <session dir> <turn> …):
// when each was first and last seen, and what its children run (argv[0], the executable file,
// --model, --json-schema).
function curatorSampler(home) {
  const procs = new Map();
  const children = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const at = now();
      const rows = (await execText('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='])).split('\n').map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
        return m && { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
      }).filter(Boolean);
      const curators = new Set();
      for (const r of rows) {
        const m = /^\S*node\S*\s+\S*curate\.mjs\s+(\S+)\s+(\d+)/.exec(r.command);
        if (!m || !m[1].startsWith(home)) continue;
        curators.add(r.pid);
        const p = procs.get(r.pid) ?? { pid: r.pid, session: path.basename(m[1]), argTurn: Number(m[2]), first: at };
        p.last = at;
        procs.set(r.pid, p);
      }
      for (const r of rows) {
        if (!curators.has(r.ppid) || children.has(r.pid)) continue;
        const exe = (await execText('lsof', ['-p', String(r.pid), '-a', '-d', 'txt', '-Fn']))
          .split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null;
        children.set(r.pid, {
          at: iso(at),
          session: procs.get(r.ppid)?.session ?? null,
          argv0: r.command.split(' ')[0],
          exe,
          model: /--model (\S+)/.exec(r.command)?.[1] ?? null,
          print: / -p /.test(` ${r.command} `),
          jsonSchema: r.command.includes('--json-schema'),
        });
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 300);
  return {
    stop: () => clearInterval(timer),
    procs: () => [...procs.values()],
    children: () => [...children.values()],
  };
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

const listDir = (p) => (exists(p) ? fs.readdirSync(p).sort() : []);

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

// Every string anywhere in a value, joined: finds text wherever a transcript entry keeps it.
const strings = (v) => (typeof v === 'string' ? [v]
  : Array.isArray(v) ? v.flatMap(strings)
    : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

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
      hookContext.push({ turn: turnOf(i), at: Date.parse(e.timestamp ?? ''), event: e.attachment.hookEvent, text: (e.attachment.content ?? []).join('\n') });
    }
  }
  return { agentCalls, toolResults, hookContext, notifications };
}

// Tool calls in transcript entries, each paired with its result: tool, key input, error, result.
export function toolCalls(list, agent = 'main', turnOf = () => null) {
  const calls = new Map();
  list.forEach((e, i) => {
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b.type === 'tool_use') {
        const message = typeof b.input?.message === 'string' ? b.input.message : null;
        calls.set(b.id, {
          agent, agentId: agent.replace(/^agent-|\.jsonl$/g, ''), turn: turnOf(i), tool: b.name,
          file: b.input?.file_path ?? b.input?.path ?? null, pattern: b.input?.pattern ?? null,
          command: b.input?.command?.slice(0, 300) ?? null, input: JSON.stringify(b.input ?? {}),
          chars: message === null ? null : [...message].length, error: null, result: null,
        });
      }
      if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const c = calls.get(b.tool_use_id);
        c.error = Boolean(b.is_error);
        c.result = blockText(b.content).slice(0, 300);
      }
    }
  });
  return [...calls.values()];
}

// The subagents' tool calls: file writes (Write/Edit) with their outcome, hand-backs, and every
// call of any tool that was denied (in -p a denial is an error result, never a prompt).
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export function subagentTools(transcriptFile, sessionId) {
  const dir = path.join(path.dirname(transcriptFile), sessionId, 'subagents');
  const calls = listDir(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => toolCalls(entries(path.join(dir, f)), f));
  return {
    calls,
    writes: calls.filter((c) => WRITE_TOOLS.includes(c.tool)),
    handbacks: calls.filter((c) => HANDBACK_TOOLS.includes(c.tool)),
    denials: calls.filter((c) => c.error && DENIED.test(c.result ?? '')),
  };
}

// --- SubagentStop probe ---------------------------------------------------------------------

// A throwaway second plugin (loaded with its own --plugin-dir) that records what hooks receive:
// every SubagentStop (field names, agent type, stop_hook_active, session_id, the return's length)
// and every PreToolUse, unmatched (tool name, tool_input keys, agent type and id, message length).
// It never prints anything, so it never affects a decision.
export function buildProbe(root) {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'slate-probe', version: '0.0.0', description: 'live-test probe' })}\n`);
  const hook = [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/record.mjs"', timeout: 10 }] }];
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks: { SubagentStop: hook, PreToolUse: hook } })}\n`);
  fs.writeFileSync(path.join(root, 'record.mjs'), `import fs from 'node:fs';
let t = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) t += c;
const i = JSON.parse(t);
const len = (m) => (typeof m === 'string' ? [...m].length : null);
const base = { at: new Date().toISOString(), keys: Object.keys(i).sort(), agent_type: i.agent_type, agent_id: i.agent_id, session_id: i.session_id };
if (i.hook_event_name === 'PreToolUse') {
  const ti = i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {};
  fs.appendFileSync(new URL('./pre-tool-use.jsonl', import.meta.url), JSON.stringify({
    ...base, tool_name: i.tool_name, input_keys: Object.keys(ti).sort(), chars: len(ti.message),
  }) + '\\n');
} else {
  fs.appendFileSync(new URL('./subagent-stop.jsonl', import.meta.url), JSON.stringify({
    ...base, stop_hook_active: i.stop_hook_active, chars: len(i.last_assistant_message),
  }) + '\\n');
}
`);
  return { stops: path.join(root, 'subagent-stop.jsonl'), preToolUse: path.join(root, 'pre-tool-use.jsonl') };
}

// The curator's binary, for the run: it runs the real one with the same args and stdout, and saves
// that stdout (the `--output-format json` result) to <root>/curator-outputs/<pid>.json, with when the
// run started and ended and the session and turn its prompt names. It lives in the curator's process
// group, so a kill of the group kills both.
export function buildRecorder(root, realBin) {
  const dir = path.join(root, 'curator-outputs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(root, 'record-claude.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const started = new Date().toISOString();
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const turn = Number(/^Current turn: (\\d+)$/m.exec(prompt)?.[1] ?? NaN);
const session = /\\/\\.sessions\\/([^/\\n]+)\\/now\\.md$/m.exec(prompt)?.[1] ?? null;
const child = spawn(${JSON.stringify(realBin)}, args, { stdio: ['inherit', 'pipe', 'inherit'] });
let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.on('close', (code, signal) => {
  fs.writeFileSync(${JSON.stringify(dir)} + '/' + process.pid + '.json', JSON.stringify({ started, at: new Date().toISOString(), session, turn, code, signal, stdout: out }));
  process.exitCode = code ?? 1;
});
`, { mode: 0o755 });
  return { bin: file, dir };
}

// Each recorded curator run: when it started and ended, its session and turn, its exit and its
// change list (structured_output), if any.
export function curatorOutputs(dir) {
  return listDir(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const r = JSON.parse(readText(path.join(dir, f)));
    let list = null;
    try {
      list = JSON.parse(r.stdout)?.structured_output ?? null;
    } catch {}
    return { file: f, started: r.started, at: r.at, session: r.session, turn: r.turn, code: r.code, list };
  }).sort((a, b) => a.at.localeCompare(b.at));
}

// Items (live or retired) whose text holds `needle`: ID → text.
export function itemsHolding(texts, needle) {
  const out = new Map();
  for (const t of texts) {
    const p = parseMemoryFile(t ?? '');
    for (const x of [...p.items, ...p.retired]) if (x.text.includes(needle)) out.set(x.id, x.text);
  }
  return out;
}

// For one turn's change lists: the items holding the needle that were added (per curator.log)
// before each list's curator run started, and which of them the lists named in `relevant`.
export function relevanceFor(lists, holding, addedAt) {
  const norm = (id) => String(id).trim().replace(/^([IAF])0*(\d+)$/, '$1$2');
  const known = new Set();
  const named = new Set();
  for (const o of lists) {
    const before = [...holding.keys()].filter((id) => (addedAt.get(id) ?? Infinity) < Date.parse(o.started));
    before.forEach((id) => known.add(id));
    const rel = new Set((o.list?.relevant ?? []).map(norm));
    before.filter((id) => rel.has(id)).forEach((id) => named.add(id));
  }
  return { known: [...known], named: [...named], missing: [...known].filter((id) => !named.has(id)) };
}

// Each slate:offload stop the probe saw, whether it was over the limit and whether it was sent back,
// plus how many times each agent was sent back. A send-back is persisted in the agent's transcript
// as one hook_blocking_error attachment (its text also appears in a "Stop hook feedback" message,
// so count attachments, not text matches); a block also makes the agent stop again with
// stop_hook_active set.
export function offloadBlocks(offloadStops, subagentsDir, handedBack = new Set()) {
  const blockEvents = (id) => entries(path.join(subagentsDir, `agent-${id}.jsonl`))
    .filter((e) => e.type === 'attachment' && e.attachment?.type === 'hook_blocking_error'
      && e.attachment.hookEvent === 'SubagentStop'
      && /^Return is \d+ chars\./.test(String(e.attachment.blockingError?.blockingError ?? '')))
    .map((e) => e.attachment.blockingError.blockingError);
  const blocks = offloadStops.map((p, i) => ({
    ...p,
    // No last_assistant_message: the agent returned through a hand-back tool, whose cap is
    // checked separately (PreToolUse); without a hand-back the return was invisible to any cap, so
    // it counts as over and unblocked.
    over: p.stop_hook_active !== true && (p.chars === null ? !handedBack.has(p.agent_id) : p.chars > 800),
    blocked: blockEvents(p.agent_id).some((t) => t.startsWith(`Return is ${p.chars} chars.`))
      || offloadStops.slice(i + 1).some((q) => q.agent_id === p.agent_id && q.stop_hook_active === true),
  }));
  const ids = [...new Set(offloadStops.map((p) => p.agent_id))];
  const blockCounts = ids.map((id) => blockEvents(id).length);
  return { blocks, blockCounts };
}

// Per offload agent that handed back: its hand-back calls in order, with length and outcome. The cap
// holds when the first call over 800 chars was denied with the cap's reason and no other call was.
export function handbackDenials(handbacks, offloadIds) {
  const denied = (c) => c.error === true && /Hand-back is \d+ chars\./.test(c.result ?? '');
  return [...new Set(handbacks.map((c) => c.agentId))].filter((id) => offloadIds.has(id)).map((id) => {
    const calls = handbacks.filter((c) => c.agentId === id);
    const firstOver = calls.findIndex((c) => c.chars !== null && c.chars > 800);
    const deniedAt = calls.map((c, i) => (denied(c) ? i : -1)).filter((i) => i >= 0);
    const ok = firstOver < 0 ? deniedAt.length === 0 : deniedAt.length === 1 && deniedAt[0] === firstOver;
    return { id, calls: calls.map((c) => ({ chars: c.chars, denied: denied(c), error: c.error })), ok };
  });
}

// offloads.md entries: `## t<turn>@<session8> <at> <agentId>` (older: no `@…`), then `transcript: <path|none>`.
export function offloadEntries(text) {
  return [...String(text ?? '').matchAll(/^## t(\d+)(?:@(\S+))? (\S+) (\S+)\ntranscript: (.*)$/gm)]
    .map((m) => ({ turn: Number(m[1]), session: m[2] ?? null, agentId: m[4], transcript: m[5] }));
}

// curator.log lines `<ISO> t<N> <status>: <detail>`, with the IDs each ok/partial line added.
export function curatorLog(text) {
  return String(text ?? '').split('\n').filter(Boolean).map((line) => {
    const m = /^(\S+) t(\d+) (\w+): (.*)$/.exec(line);
    if (!m) return { line, at: null, turn: null, status: null, adds: [] };
    const detail = m[4];
    const adds = ['ok', 'partial'].includes(m[3]) ? [
      ...[...detail.matchAll(/\b\d+:add ([IAF]\d+)/g)].map((x) => x[1]),
      ...[...detail.matchAll(/\b\d+:replace [IAF]\d+ ([IAF]\d+)/g)].map((x) => x[1]),
      ...[...detail.matchAll(/\badopt ([IAF]\d+)/g)].map((x) => x[1]),
    ] : [];
    return { line, at: Date.parse(m[1]), turn: Number(m[2]), status: m[3], detail, adds };
  });
}

// Every item and retired line in the slate's shared files and topic files: id → where it is and
// who added it.
export function memoryIds(mem, topics = {}) {
  const out = [];
  const files = [...SHARED_FILES.map((f) => [f, mem[f]]), ...Object.entries(topics).map(([slug, t]) => [`topics/${slug}.md`, t])];
  for (const [f, text] of files) {
    const p = parseMemoryFile(text ?? '');
    for (const x of p.items) out.push({ id: x.id, file: f, session: x.session, turn: x.turn, retired: false });
    for (const x of p.retired) out.push({ id: x.id, file: f, session: x.session, turn: x.turn, retired: true });
  }
  return out;
}

// topics/<slug>.md texts by slug.
const topicTexts = (slate) => Object.fromEntries(listDir(path.join(slate, 'topics')).filter((f) => f.endsWith('.md'))
  .map((f) => [f.slice(0, -3), readText(path.join(slate, 'topics', f)) ?? '']));

// Denials sorted for check 3c. A Read, Write or Edit denied on a slate path fails the run: the
// permission hook should have allowed it. Any other tool denied there (Bash, since Claude Code
// 2.1.308 has no Grep or Glob tool) is a known limitation, reported as a note. A result's
// permission_denials repeat calls already found in a transcript, so each tool+input counts once.
const FILE_TOOLS = ['Read', 'Write', 'Edit'];
export function classifyDenials(denials, slate, home) {
  const spellings = [slate, slate.replace(/^\/private\//, '/'), path.basename(home)];
  const touches = (d) => spellings.some((p) => d.input.includes(p));
  const seen = new Set();
  const unique = denials.filter((d) => !seen.has(`${d.tool}\0${d.input}`) && seen.add(`${d.tool}\0${d.input}`));
  return {
    file: unique.filter((d) => touches(d) && FILE_TOOLS.includes(d.tool)),
    note: unique.filter((d) => touches(d) && !FILE_TOOLS.includes(d.tool)),
    other: unique.filter((d) => !touches(d)),
  };
}

export function denialChecks(bySession, slate, home) {
  const text = (d) => `${d.tool} ${d.command ?? d.file ?? d.input.slice(0, 120)}`;
  const sorted = Object.entries(bySession).map(([name, ds]) => [name, classifyDenials(ds, slate, home)]);
  const each = (f) => sorted.map(([name, x]) => `${name}: ${f(x).map(text).join('; ') || 'none'}`).join('; ');
  return [
    {
      name: '3c. no Read, Write or Edit call on a slate path was denied, in either session',
      pass: sorted.every(([, x]) => x.file.length === 0),
      detail: `${each((x) => x.file)}; denials outside the slate: ${each((x) => x.other)}`,
      soft: false,
    },
    {
      name: 'note: other calls on slate paths denied (known limitation, not a failure: no Grep/Glob tool in 2.1.308)',
      pass: true,
      detail: `${sorted.reduce((n, [, x]) => n + x.note.length, 0)} denied; ${each((x) => x.note)}`,
      soft: true,
    },
  ];
}

function printChecks(checks) {
  console.log('\nchecks:');
  for (const c of checks) console.log(`  ${c.pass ? (c.soft ? 'INFO' : 'PASS') : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const hard = checks.filter((c) => !c.soft);
  return { passed: hard.filter((c) => c.pass).length, total: hard.length };
}

// Re-evaluates a saved run (`--recheck <results.json> [--out <file>]`) where the saved data allows:
// the denial checks (3c and its note). Every other check is carried over as recorded. No model calls.
function recheck(file) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fresh = denialChecks({ A: r.A.denials, B: r.B.denials }, r.slate, r.home);
  const stale = (c) => c.name.startsWith('3c.') || c.name.startsWith('note: ');
  const at = r.checks.findIndex(stale);
  const before = r.checks.slice(0, at < 0 ? r.checks.length : at).filter((c) => !stale(c));
  const rest = r.checks.slice(before.length).filter((c) => !stale(c));
  const replaced = r.checks.filter(stale);
  r.checks = [...before, ...fresh, ...rest];
  r.rechecked = { from: file, at: new Date().toISOString(), replaced: replaced.map((c) => c.name), with: fresh.map((c) => c.name) };
  const out = outArg >= 0 ? path.resolve(argv[outArg + 1]) : file.replace(/\.json$/, '.recheck.json');
  fs.writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
  console.log(`rechecked ${file}: replaced ${replaced.map((c) => JSON.stringify(c.name)).join(', ') || 'nothing'}`);
  const { passed, total } = printChecks(r.checks);
  console.log(`\n${passed}/${total} checks passed (rechecked from saved outputs, no model calls)\nresults: ${out}`);
  process.exitCode = passed === total ? 0 : 1;
}

// --- main ------------------------------------------------------------------------------------

class Abort extends Error {}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function main() {
  const bin = claudeBin();
  const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = tmp('slate-home-');
  const probeDir = tmp('slate-probe-');
  const probeLogs = buildProbe(probeDir);
  const recorder = buildRecorder(probeDir, bin);
  const env = cleanEnv(home, recorder.bin);
  const version = (await run(bin, ['--version'], { cwd: os.tmpdir(), env, timeoutMs: 30_000 })).stdout.trim();
  const projectA = tmp('slate-acc-');
  const fileCount = buildRepo(projectA);
  const projectB = tmp('slate-acc-b-');
  fs.writeFileSync(path.join(projectB, 'README.md'), '# notes\n\nA second working folder on the same topic.\n');
  const slate = (await createSlate(home, SLATE)).dir;
  const reportsDir = path.join(slate, 'reports');
  const userSlate = path.join(os.homedir(), 'slate');
  const before = { A: snapshot(projectA), B: snapshot(projectB), userSlate: snapshot(userSlate), userSlateExists: exists(userSlate) };
  const out = outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.join(os.tmpdir(), `slate-acc-results-${randomUUID()}.json`);

  const session = (name, cwd, prompts) => {
    const id = randomUUID();
    return { name, id, cwd, prompts, dir: path.join(slate, '.sessions', id), turns: [], ranges: [], transcript: () => transcriptPath(cwd, id) };
  };
  const A = session('A', projectA, A_PROMPTS);
  const B = session('B', projectB, B_PROMPTS);
  console.log(`SLATE_HOME ${home}\nA ${A.id} in ${projectA} (${fileCount} files)\nB ${B.id} in ${projectB}\nclaude ${bin} (${version}), main model ${MODEL}`);

  const ctx = { aborted: null };
  const events = { bLinked: deferred(), aTurn2: deferred(), aTurn3: deferred(), aCurated4: deferred() };
  const releaseAll = () => Object.values(events).forEach((d) => d.resolve(null));

  const common = [
    '--plugin-dir', PLUGIN,
    '--plugin-dir', probeDir,
    '--model', MODEL,
    '--setting-sources', 'project,local',
    '--output-format', 'stream-json', '--verbose',
  ];

  // Records a finished turn; stops the run when the plugin guard fails or no session folder exists.
  function recordTurn(s, fields, init) {
    const guard = pluginGuard(init);
    const turn = { n: s.turns.length + 1, ...fields, plugins: guard.slates, permissionMode: guard.mode };
    turn.resultChars = (turn.result ?? '').length;
    s.turns.push(turn);
    console.log(`${s.name} turn ${turn.n}: exit ${turn.exit}, ${turn.wallSec}s, $${turn.costUsd ?? turn.cumulativeCostUsd}, reply ${turn.resultChars} chars: ${String(turn.result).slice(0, 160).replace(/\n/g, ' ')}`);
    if (!guard.ok) {
      ctx.aborted = `${s.name} turn ${turn.n}: ${guard.why}`;
      throw new Abort(ctx.aborted);
    }
    if (!exists(path.join(s.dir, 'session.json'))) {
      ctx.aborted = `${s.name}: no session folder after turn ${turn.n}`;
      throw new Abort(ctx.aborted);
    }
    return turn;
  }

  const probeRows = (file) => (readText(file) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // One message into a long-lived session. The turn ends when its result is in, every Agent its
  // main thread launched since has stopped, a stop after that result has been followed by another
  // result (a background agent's continuation), and stdout has been quiet for 3 s.
  async function runStreamTurn(s, st, prompt) {
    if (ctx.aborted) throw new Abort(ctx.aborted);
    const lines = lineCount(s.transcript());
    const startAt = now();
    const nResults = st.results.length;
    const nInits = st.inits.length;
    st.send(prompt, s.id);
    await until(() => st.results.length > nResults || st.code !== null, TURN_TIMEOUT_MS);
    const first = st.results[nResults];
    const settled = Boolean(first) && await until(() => {
      const since = (x) => Date.parse(x.at) >= startAt && x.session_id === s.id;
      const launches = probeRows(probeLogs.preToolUse).filter((x) => since(x) && !x.agent_id && ['Agent', 'Task'].includes(x.tool_name)).length;
      const stops = probeRows(probeLogs.stops).filter(since);
      if (new Set(stops.map((x) => x.agent_id)).size < launches) return false;
      const lastStop = Math.max(0, ...stops.map((x) => Date.parse(x.at)));
      if (lastStop > first.at && !st.results.some((r) => r.at > lastStop)) return false;
      return now() - st.lastOut > 3000;
    }, TURN_TIMEOUT_MS);
    s.ranges.push([lines, lineCount(s.transcript())]);
    const results = st.results.slice(nResults);
    const last = results.at(-1);
    return recordTurn(s, {
      prompt,
      startAt: iso(startAt),
      endAt: iso(now()),
      exit: st.code,
      streamed: true,
      settled,
      results: results.length,
      wallSec: secs(now() - startAt),
      result: last?.result ?? null,
      isError: last?.is_error ?? null,
      costUsd: null,
      cumulativeCostUsd: last?.total_cost_usd ?? null,
      numTurns: results.reduce((n, r) => n + (r.num_turns ?? 0), 0),
      permissionDenials: results.flatMap((r) => r.permission_denials ?? []),
      stderr: st.stderr.trim().slice(-500),
    }, st.inits[nInits]);
  }

  async function runTurn(s, prompt) {
    if (ctx.aborted) throw new Abort(ctx.aborted);
    const first = s.turns.length === 0;
    const args = ['-p', prompt, ...(first ? ['--session-id', s.id] : ['--resume', s.id]), ...common];
    const lines = lineCount(s.transcript());
    const startAt = now();
    let r;
    let retried = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      r = await run(bin, args, { cwd: s.cwd, env, timeoutMs: TURN_TIMEOUT_MS });
      Object.assign(r, parseStream(r.stdout));
      const failed = r.code !== 0 || !r.result || r.result.is_error;
      const grew = lineCount(s.transcript()) > lines;
      if (failed && attempt === 1 && !grew && TRANSIENT.test(`${r.stderr} ${r.result?.result ?? ''}`)) {
        retried = true;
        await sleep(30_000);
        continue;
      }
      break;
    }
    s.ranges.push([lines, lineCount(s.transcript())]);
    return recordTurn(s, {
      prompt,
      startAt: iso(startAt),
      endAt: iso(now()),
      exit: r.code,
      retried,
      wallSec: secs(r.ms),
      result: r.result?.result ?? null,
      isError: r.result?.is_error ?? null,
      costUsd: r.result?.total_cost_usd ?? null,
      numTurns: r.result?.num_turns ?? null,
      permissionDenials: r.result?.permission_denials ?? null,
      stderr: r.stderr.trim().slice(-500),
    }, r.init);
  }

  async function settle(s, turn) {
    const w = await waitCurator(s.dir);
    turn.curatorOk = w.ok;
    turn.curatorSec = secs(w.ms);
    turn.settledAt = iso(now());
    console.log(`  ${s.name} curator ${w.ok ? 'settled' : 'NOT settled'} after ${turn.curatorSec}s`);
  }

  async function driveA() {
    for (let t = 0; t < A.prompts.length; t++) {
      if (t === 1) await events.bLinked.promise; // B's later turns are timed against A's curators
      const turn = await runTurn(A, A.prompts[t]);
      if (turn.n === 2) events.aTurn2.resolve(true);
      if (turn.n === 3) events.aTurn3.resolve(true);
      await settle(A, turn);
      if (turn.n === 4) events.aCurated4.resolve(true);
    }
  }

  // B links in its own -p run, then works in one long-lived session, as an interactive peer does:
  // no SessionStart between its turns, so each prompt's change line shows what A changed since
  // B's previous prompt (a --resume per turn would re-inject memory and reset that baseline).
  async function driveB() {
    await runTurn(B, B.prompts[0]);
    events.bLinked.resolve(true);
    const st = startStream(bin, ['-p', '--input-format', 'stream-json', '--resume', B.id, ...common], { cwd: B.cwd, env });
    try {
      const waits = [null, events.aTurn2, events.aTurn3, events.aCurated4];
      const after = [null, 'A turn 2 ended', 'A turn 3 ended', 'A turn 4 curated'];
      for (let t = 1; t < B.prompts.length; t++) {
        if (!(await waits[t].promise)) throw new Abort(ctx.aborted ?? 'A stopped early');
        const turn = await runStreamTurn(B, st, B.prompts[t]);
        turn.after = after[t];
      }
    } finally {
      await st.close(60_000);
    }
    await settle(B, B.turns.at(-1));
  }

  const sampler = curatorSampler(home);
  const outcomes = await Promise.allSettled([
    driveA().catch((e) => { ctx.aborted ??= e.message; throw e; }).finally(releaseAll),
    driveB().catch((e) => { ctx.aborted ??= e.message; throw e; }).finally(releaseAll),
  ]);
  for (const o of outcomes) if (o.status === 'rejected' && !(o.reason instanceof Abort)) console.log(`driver error: ${o.reason?.stack ?? o.reason}`);
  // Whatever is still curating finishes before anything is measured.
  for (const s of [A, B]) if (exists(path.join(s.dir, 'session.json'))) await waitCurator(s.dir);
  await sleep(1000);
  sampler.stop();

  // --- assertions ---
  const mem = Object.fromEntries(SHARED_FILES.map((f) => [f, readText(path.join(slate, f))]));
  const topics = topicTexts(slate);
  const live = [...ITEM_FILES.map((f) => mem[f] ?? ''), ...Object.values(topics)].join('\n');
  const probes = (readText(probeLogs.stops) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const preToolUses = (readText(probeLogs.preToolUse) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const offloadsText = readText(path.join(slate, 'offloads.md'));
  const offloads = offloadEntries(offloadsText);
  const reports = listDir(reportsDir);
  const slateSpellings = [slate, slate.replace(/^\/private\//, '/')];
  const inReports = (p) => typeof p === 'string' && slateSpellings.some((r) => p.startsWith(`${path.join(r, 'reports')}/`));

  for (const s of [A, B]) {
    const tp = s.transcript();
    const all = entries(tp);
    const turnOf = (i) => s.ranges.findIndex(([a, b]) => i >= a && i < b) + 1;
    s.tp = tp;
    s.a = analyse(all, s.ranges);
    // Sidechain entries blanked rather than dropped, so indexes still match the turn ranges.
    s.mainCalls = toolCalls(all.map((e) => (e.isSidechain ? {} : e)), 'main', turnOf);
    s.sub = subagentTools(tp, s.id);
    s.now = readText(path.join(s.dir, 'now.md'));
    s.log = readText(path.join(s.dir, 'curator.log')) ?? '';
    s.logLines = curatorLog(s.log);
    s.slateTurns = exists(path.join(s.dir, 'session.json')) ? (await readSession(s.dir)).turn : 0;
    s.userTurns = s.turns.slice(1).map((t) => t.n);
    s.queue = listDir(path.join(s.dir, 'queue'));
    s.offloadStops = probes.filter((p) => p.agent_type === 'slate:offload' && p.session_id === s.id);
    s.offloadIds = new Set(s.offloadStops.map((p) => p.agent_id));
    s.handedBack = new Set(s.sub.handbacks.filter((c) => s.offloadIds.has(c.agentId) && c.error === false).map((c) => c.agentId));
    Object.assign(s, offloadBlocks(s.offloadStops, path.join(path.dirname(tp), s.id, 'subagents'), s.handedBack));
    s.hb = handbackDenials(s.sub.handbacks, s.offloadIds);
    s.resultDenials = s.turns.flatMap((t) => (t.permissionDenials ?? []).map((d) => ({ turn: t.n, tool: d.tool_name, input: JSON.stringify(d.tool_input ?? {}) })));
    s.denials = [...s.mainCalls.filter((c) => c.error && DENIED.test(c.result ?? '')), ...s.sub.denials, ...s.resultDenials];
    // The link turn: the skill text as the model got it (a meta user message), and the Bash call
    // that linked. Hook attachments elsewhere quote `${CLAUDE_PLUGIN_ROOT}` legitimately.
    const [l0, l1] = s.ranges[0] ?? [0, 0];
    s.linkText = all.slice(l0, l1).filter((e) => e.type === 'user' && e.isMeta)
      .map((e) => strings(e.message?.content).join('\n')).filter((t) => t.includes('slate.mjs')).join('\n');
    s.linkCalls = s.mainCalls.filter((c) => c.turn === 1 && c.tool === 'Bash' && /slate\.mjs"?\s+link\b/.test(c.command ?? ''));
    s.entryChecks = [...s.offloadIds].map((id) => {
      const mine = offloads.filter((e) => e.agentId === id);
      const file = mine[0]?.transcript;
      const body = file && file !== 'none' ? readText(file) : null;
      return { id, entries: mine.length, session: mine[0]?.session ?? null, transcript: file ?? null, exists: body !== null, toolCall: /"type":"tool_use"/.test(body ?? '') };
    });
  }

  // Check 1: B's first UserPromptSubmit output after A's "pnpm" turn was curated, by transcript
  // time. It may be a harness prompt (a task-notification) inside a B turn that was still running.
  const aPnpmEnd = Date.parse(A.turns[3]?.endAt ?? '');
  const pnpmLog = A.logLines.find((l) => l.status === 'ok' && l.at > aPnpmEnd) ?? null;
  const bNext = pnpmLog && B.a.hookContext.filter((h) => h.event === 'UserPromptSubmit' && h.at > pnpmLog.at).sort((x, y) => x.at - y.at)[0];
  const pnpmLine = bNext?.text.split('\n').find((l) => /\+I\d+ [^·\n]*pnpm/i.test(l)) ?? null;
  const bAfter = B.turns.find((t) => t.after === 'A turn 4 curated');

  // Check 2: curator runs per session (ps), each tied to the curator.log line written as it ended.
  const procs = sampler.procs();
  const runsOf = (s) => procs.filter((p) => p.session === s.id).map((p) => {
    // A run logs as it ends; first is at most one poll after it started, and a log line takes seconds.
    const logged = s.logLines.filter((l) => l.at !== null && l.status !== 'retry' && l.at >= p.first && l.at <= p.last + 1500);
    return { pid: p.pid, start: p.first, end: p.last, log: logged.map((l) => `${iso(l.at)} t${l.turn} ${l.status}`) };
  });
  const aRuns = runsOf(A);
  const bRuns = runsOf(B);
  const overlaps = aRuns.flatMap((x) => bRuns.map((y) => ({ a: x, b: y, ms: Math.min(x.end, y.end) - Math.max(x.start, y.start) })))
    .filter((o) => o.ms > 0 && o.a.log.length && o.b.log.length);
  const fmtRun = (r) => `${iso(r.start).slice(11, 21)}–${iso(r.end).slice(11, 21)} (${r.log.join(', ') || 'no log line'})`;
  const ids = memoryIds(mem, topics);
  const idCounts = ids.reduce((m, x) => m.set(x.id, (m.get(x.id) ?? 0) + 1), new Map());
  const dupIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id);
  const added = [A, B].flatMap((s) => s.logLines.flatMap((l) => l.adds.map((id) => ({ id, session: s.id.slice(0, 8), by: s.name, turn: l.turn }))));
  const missing = added.filter((x) => !ids.some((m) => m.id === x.id && (m.session === x.session || m.turn === 0)));
  const unexplained = ids.filter((m) => !added.some((x) => x.id === m.id));
  const addsBy = (s) => added.filter((x) => x.by === s.name).map((x) => x.id);

  // Check 3: A's report write and B's read of it.
  const reportWrites = A.sub.writes.concat(A.mainCalls.filter((c) => WRITE_TOOLS.includes(c.tool))).filter((c) => inReports(c.file));
  const failedWrites = [...A.sub.writes, ...B.sub.writes].filter((w) => w.error);
  const aReports = new Set(reportWrites.filter((w) => w.error === false).map((w) => path.basename(w.file)));
  const bReads = [...B.mainCalls, ...B.sub.calls].filter((c) => c.tool === 'Read' && inReports(c.file));
  const bReadOk = bReads.filter((c) => c.error === false && aReports.has(path.basename(c.file)));

  // Check 4: the working folders and ~/slate, before and after.
  const after = { A: snapshot(projectA), B: snapshot(projectB), userSlate: snapshot(userSlate), userSlateExists: exists(userSlate) };
  const cwdChanges = { A: snapshotDiff(before.A, after.A), B: snapshotDiff(before.B, after.B) };
  const userSlateChanges = before.userSlateExists === after.userSlateExists ? snapshotDiff(before.userSlate, after.userSlate) : ['~/slate created or removed'];

  // Curator change lists.
  const children = sampler.children();
  const badLog = [A, B].flatMap((s) => s.logLines.filter((l) => /\b(partial|error)\b/i.test(l.line)).map((l) => `${s.name}: ${l.line}`));
  const noList = [A, B].flatMap((s) => s.logLines.filter((l) => /no change list/.test(l.line)));
  const retries = [A, B].flatMap((s) => s.logLines.filter((l) => l.status === 'retry').map((l) => `${s.name} t${l.turn}`));

  const turns5 = A.turns[4]?.result ?? '';
  const both = (f) => [A, B].map((s) => `${s.name}: ${f(s)}`).join('; ');
  const allTurns = [...A.turns, ...B.turns];
  const offload3 = A.a.agentCalls.filter((c) => c.turn === 3 && c.subagent_type === 'slate:offload');
  const bigResults = A.a.toolResults.filter((r) => r.chars > MAIN_THREAD_MAX);
  const bigNotes = [A, B].flatMap((s) => s.a.notifications.filter((n) => n.chars > MAIN_THREAD_MAX));
  const lateAgents = [...A.a.agentCalls.filter((c) => c.turn >= 4), ...B.a.agentCalls.filter((c) => c.turn >= 4)];
  const npmAgents = lateAgents.filter((c) => NPM_CMD.test(JSON.stringify(c.input)));
  const topicAssumptions = Object.entries(topics).map(([slug, t]) => [`topics/${slug}.md (A items)`,
    parseMemoryFile(t).items.filter((x) => x.type === 'A').map((x) => x.text).join('\n')]);
  const npmRules = [['instructions.md', mem['instructions.md']], ['assumptions.md', mem['assumptions.md']], ...topicAssumptions,
    ['A now.md', A.now], ['B now.md', B.now]]
    .filter(([, t]) => NPM.test(t ?? '')).map(([f]) => f);

  // Relevance and usage: every change list the recorder kept, one per curator log line that ran
  // the model to the end (ok, partial, retry); usage.json against the F and A items added.
  const outputs = curatorOutputs(recorder.dir);
  const lists = outputs.filter((o) => Array.isArray(o.list?.ops));
  const relevantIds = [...new Set(lists.flatMap((o) => o.list.relevant ?? []))];
  // B's "!!" turn: its answer names the file the report marks "!!", src/db/pool.rs. Its slate turn is
  // its index in B.turns, since the link turn isn't one.
  const bangTurn = B.turns.findIndex((t) => t.prompt === B_PROMPTS[2]);
  const bangLists = lists.filter((o) => o.session === B.id && o.turn === bangTurn);
  const addedAt = new Map([A, B].flatMap((s) => s.logLines.flatMap((l) => l.adds.map((id) => [id, l.at]))));
  const holding = itemsHolding([...SHARED_FILES.map((f) => mem[f]), ...Object.values(topics)], 'pool.rs');
  const bang = relevanceFor(bangLists, holding, addedAt);
  const usageText = readText(path.join(slate, 'usage.json'));
  let usage = null;
  try {
    usage = usageText === null ? null : JSON.parse(usageText);
  } catch {}
  const liveIds = new Set(ids.filter((x) => !x.retired).map((x) => x.id));
  const addedFA = [...new Set(added.map((x) => x.id).filter((id) => /^[FA]/.test(id) && liveIds.has(id)))];
  const notInUsage = addedFA.filter((id) => !usage || !(id in usage));
  const uncounted = bang.known.filter((id) => liveIds.has(id) && !(usage?.[id]?.count >= 1));
  const SHAPE = ['agent_type', 'last_assistant_message', 'stop_hook_active', 'session_id', 'agent_id'];
  const offloadStops = [...A.offloadStops, ...B.offloadStops];
  const noChange = (s) => s.userTurns.filter((n) => !s.a.hookContext.some((h) => h.turn === n && h.event === 'UserPromptSubmit' && h.text.includes(REMINDER)));
  const okMissing = (s) => Array.from({ length: s.slateTurns }, (_, i) => i + 1).filter((t) => !new RegExp(`^\\S+ t${t} ok:`, 'm').test(s.log));
  const sessionsHere = listDir(path.join(slate, '.sessions'));
  const linkOk = (s) => exists(path.join(s.dir, 'session.json')) && (s.turns[0]?.result ?? '').trim() !== '' && !(s.turns[0]?.result ?? '').trim().includes('\n');
  const substituted = (s) => s.linkText.includes(`slate.mjs" link "${s.id}"`) && s.linkText.includes(`it is \`${SLATE}\``)
    && s.linkText.includes(`${PLUGIN}/scripts/slate.mjs`) && !/\$\{CLAUDE_(SESSION_ID|PLUGIN_ROOT)\}|\$ARGUMENTS/.test(s.linkText);
  const linkCallOk = (s) => s.linkCalls.some((c) => c.command.includes(s.id) && c.command.includes(SLATE) && c.error === false && /^(linked|already-linked)\b/.test(c.result ?? ''));

  const checks = [
    ['every turn ran with one slate plugin (this checkout\'s) in the default permission mode',
      !ctx.aborted && allTurns.every((t) => t.plugins.length === 1 && t.permissionMode === 'default'),
      `${allTurns.length} turns; slate plugins: ${[...new Set(allTurns.map((t) => JSON.stringify(t.plugins)))].join(' | ')}; modes: ${[...new Set(allTurns.map((t) => t.permissionMode))].join(', ')}${ctx.aborted ? `; ABORTED: ${ctx.aborted}` : ''}`],
    [`/slate:link ${SLATE} linked each session by its own ID and replied in one line`,
      linkOk(A) && linkOk(B) && sessionsHere.length === 2 && sessionsHere.includes(A.id) && sessionsHere.includes(B.id),
      `.sessions/: ${sessionsHere.map((x) => x.slice(0, 8)).join(', ')}; ${both((s) => JSON.stringify(s.turns[0]?.result ?? null))}`],
    ['link skill text had ${CLAUDE_SESSION_ID}, ${CLAUDE_PLUGIN_ROOT} and $ARGUMENTS substituted, and its Bash link call ran',
      substituted(A) && substituted(B) && linkCallOk(A) && linkCallOk(B),
      both((s) => `substituted ${substituted(s)}; link call ${s.linkCalls.map((c) => `${c.command.replace(PLUGIN, '<plugin>').replace(s.id, '<own id>')} → ${c.error ? 'ERROR' : JSON.stringify((c.result ?? '').split('\n')[0])}`).join(', ') || 'none'}`)],
    ['1. after A\'s "pnpm" turn was curated, B\'s next UserPromptSubmit context has +I with pnpm',
      Boolean(pnpmLog?.adds.some((id) => id.startsWith('I'))) && pnpmLine !== null,
      `A log ${pnpmLog?.line ?? 'none'}; B's next UserPromptSubmit: turn ${bNext?.turn ?? '?'} at ${Number.isFinite(bNext?.at) ? iso(bNext.at) : '?'}, line ${JSON.stringify(pnpmLine ?? bNext?.text.slice(0, 300) ?? null)}; B's "package manager" answer (turn ${bAfter?.n ?? '?'}): ${JSON.stringify(bAfter?.result ?? null)}`],
    ['2a. A\'s and B\'s curators ran at overlapping times (ps start/end, curator.log line at the end)',
      overlaps.length > 0,
      `${overlaps.length} overlapping pair(s)${overlaps.length ? `, longest ${secs(Math.max(...overlaps.map((o) => o.ms)))}s` : ''}; A runs: ${aRuns.map(fmtRun).join('; ') || 'none'}; B runs: ${bRuns.map(fmtRun).join('; ') || 'none'}`],
    ['2b. every item either session added is in memory with its session tag, IDs are unique, and every ID came from a logged add',
      added.length > 0 && missing.length === 0 && dupIds.length === 0 && unexplained.length === 0 && addsBy(A).length > 0 && addsBy(B).length > 0,
      `A added ${addsBy(A).join(', ') || 'none'}; B added ${addsBy(B).join(', ') || 'none'}; ${ids.length} IDs in memory; missing ${missing.map((x) => x.id).join(', ') || 'none'}; duplicate ${dupIds.join(', ') || 'none'}; unexplained ${unexplained.map((x) => x.id).join(', ') || 'none'}`],
    ['3a. A\'s offload wrote reports/<slug>.md in the default mode: the Write went through, no Write/Edit failed',
      aReports.size > 0 && failedWrites.length === 0,
      `reports: ${reports.join(', ') || 'none'}; A's writes: ${reportWrites.map((w) => `${w.tool} ${path.basename(w.file)} ${w.error ? `ERROR ${w.result}` : 'ok'}`).join('; ') || 'none'}`],
    ['3b. B read A\'s report with Read, no denial',
      bReadOk.length > 0,
      `reads: ${bReads.map((c) => `${c.agent === 'main' ? 'main' : 'subagent'} Read ${path.basename(c.file)} ${c.error ? `ERROR ${c.result}` : 'ok'}`).join('; ') || 'none'}`],
    ...denialChecks({ A: A.denials, B: B.denials }, slate, home).map((c) => [c.name, c.pass, c.detail, c.soft]),
    ['4. nothing was written under either session\'s cwd (nor ~/slate)',
      cwdChanges.A.length === 0 && cwdChanges.B.length === 0 && userSlateChanges.length === 0,
      `A cwd: ${cwdChanges.A.join(', ') || 'unchanged'} (${Object.keys(before.A).length} entries); B cwd: ${cwdChanges.B.join(', ') || 'unchanged'}; ~/slate: ${userSlateChanges.join(', ') || (after.userSlateExists ? 'unchanged' : 'absent, as before')}`],
    ['curator --json-schema change lists came back and applied: adds in both sessions, no "no change list"',
      addsBy(A).length > 0 && addsBy(B).length > 0 && noList.length === 0 && children.length > 0 && children.every((c) => c.jsonSchema && c.print),
      `${[A, B].map((s) => `${s.name}: ${s.logLines.filter((l) => l.status === 'ok').length} ok, ${addsBy(s).length} add(s)`).join('; ')}; curator children seen ${children.length}, all -p with --json-schema ${children.every((c) => c.jsonSchema && c.print)}; retries: ${retries.join(', ') || 'none'}`],
    ['A turn 3 used an Agent call with slate:offload', offload3.length > 0,
      `${offload3.length} slate:offload call(s) in turn 3; all Agent calls: ${both((s) => s.a.agentCalls.map((c) => `t${c.turn} ${c.subagent_type}`).join(', ') || 'none')}`],
    [`no A main-thread tool_result over ${MAIN_THREAD_MAX} chars`, bigResults.length === 0,
      `max ${Math.max(0, ...A.a.toolResults.map((r) => r.chars))} chars over ${A.a.toolResults.length} results${bigResults.length ? `; over: ${JSON.stringify(bigResults)}` : ''}`],
    [`B main-thread tool_results (not asserted: B reads a report)`, true,
      `max ${Math.max(0, ...B.a.toolResults.map((r) => r.chars))} chars over ${B.a.toolResults.length} results: ${B.a.toolResults.map((r) => `t${r.turn} ${r.tool} ${r.chars}`).join(', ')}`, true],
    [`no main-thread harness message (task-notification, agent-message, …) over ${MAIN_THREAD_MAX} chars`, bigNotes.length === 0,
      both((s) => s.a.notifications.map((n) => `t${n.turn} ${n.kind} ${n.chars} chars (result ${n.resultChars})`).join(', ') || 'none')],
    ['no Agent brief from turn 4 on (A or B) contains an npm command', npmAgents.length === 0,
      `${lateAgents.length} Agent call(s) from turn 4 on, ${npmAgents.length} with ${NPM_CMD}`],
    ['no npm in instructions.md, assumptions.md, topic assumptions or either now.md (facts exempt)', npmRules.length === 0, npmRules.join(', ') || 'none match'],
    ['superseded.md matches /\\bnpm\\b/', NPM.test(mem['superseded.md'] ?? ''), ''],
    ['A turn-5 answer contains pnpm', /pnpm/.test(turns5), JSON.stringify(turns5)],
    ['stg-7.internal is in live memory', live.includes('stg-7.internal'),
      [...ITEM_FILES.filter((f) => (mem[f] ?? '').includes('stg-7.internal')),
        ...Object.keys(topics).filter((slug) => topics[slug].includes('stg-7.internal')).map((slug) => `topics/${slug}.md`)].join(', ') || 'absent'],
    ['curator.log has no line matching /\\b(partial|error)\\b/i (both sessions)', badLog.length === 0, badLog.join(' | ')],
    ['every user turn got the slate change line', noChange(A).length === 0 && noChange(B).length === 0,
      both((s) => (noChange(s).length ? `missing on turn(s) ${noChange(s).join(', ')}` : `turns ${s.userTurns.join(', ')}`))],
    ['slate counted only user prompts as turns', [A, B].every((s) => s.slateTurns === s.userTurns.length),
      both((s) => `${s.slateTurns} slate turn(s) for ${s.userTurns.length} user prompt(s); harness messages: ${s.a.notifications.map((n) => `t${n.turn} ${n.kind}`).join(', ') || 'none'}`)],
    ['curator.log has an ok line for every slate turn', [A, B].every((s) => s.slateTurns > 0 && okMissing(s).length === 0),
      both((s) => `${s.slateTurns} slate turn(s)${okMissing(s).length ? `; no ok for t${okMissing(s).join(', t')}` : ''}`)],
    ['SubagentStop input carries agent_type, stop_hook_active, agent_id, its session_id, and last_assistant_message unless the agent handed back',
      offloadStops.length > 0 && [A, B].every((s) => s.offloadStops.every((p) => SHAPE.every((k) => p.keys.includes(k) || (k === 'last_assistant_message' && s.handedBack.has(p.agent_id))))),
      `${probes.length} SubagentStop(s), ${offloadStops.length} slate:offload (A ${A.offloadStops.length}, B ${B.offloadStops.length}); session_ids ${[...new Set(probes.map((p) => (p.session_id === A.id ? 'A' : p.session_id === B.id ? 'B' : 'OTHER')))].join(',')}; keys: ${[...new Set(probes.flatMap((p) => p.keys))].join(',')}`],
    ['every slate:offload return over 800 chars was sent back, at most once per agent',
      [A, B].every((s) => s.blocks.every((b) => !b.over || b.blocked) && s.blockCounts.every((n) => n <= 1)),
      [A, B].flatMap((s) => s.blocks.map((b) => `${s.name} ${String(b.agent_id ?? '?').slice(0, 6)} ${b.chars === null ? 'no last_assistant_message' : `${b.chars} chars`}${b.stop_hook_active ? ' (stop_hook_active)' : ''}${b.over ? (b.blocked ? ' blocked' : ' NOT blocked') : ''}`)).join('; ') || 'no offload stops'],
    ['every slate:offload agent that stopped has one offloads.md entry, tagged with its session, whose transcript exists and has a tool call',
      offloadStops.length > 0 && [A, B].every((s) => s.entryChecks.every((e) => e.entries === 1 && e.session === s.id.slice(0, 8) && e.exists && e.toolCall)),
      `${offloads.length} entr(ies); ${[A, B].flatMap((s) => s.entryChecks.map((e) => `${s.name} ${e.id.slice(0, 6)}: ${e.entries} entr(ies) @${e.session}, transcript ${e.transcript ? (e.exists ? 'exists' : 'MISSING') : 'none'}${e.toolCall ? ', tool call' : ''}`)).join('; ') || 'no offload stops'}`],
    ['each session\'s queue/ holds at most its newest turn\'s file',
      [A, B].every((s) => s.queue.every((f) => f === `${String(s.slateTurns).padStart(4, '0')}.md`)),
      both((s) => `${s.queue.join(', ') || 'empty'} (newest turn ${s.slateTurns})`)],
    ['every slate:offload hand-back over 800 chars was denied exactly once', [A, B].every((s) => s.hb.every((h) => h.ok)),
      `${[A, B].flatMap((s) => s.hb.map((h) => `${s.name} ${h.id.slice(0, 6)}: ${h.calls.map((c) => `${c.chars ?? '?'} chars ${c.denied ? 'denied' : c.error ? 'error' : 'ok'}`).join(' → ')}`)).join('; ') || 'no hand-backs'}; probe saw ${preToolUses.filter((x) => HANDBACK_TOOLS.includes(x.tool_name)).length} hand-back PreToolUse(s)`],
    ['T1a. B\'s change list for the "!!" turn names, in `relevant`, every item holding pool.rs added before its curator ran',
      bangLists.length > 0 && bang.missing.length === 0,
      `B slate turn ${bangTurn}: ${bangLists.length} change list(s), relevant ${bangLists.map((o) => JSON.stringify(o.list.relevant)).join(' ') || 'none'}; items holding pool.rs: ${[...holding].map(([id, t]) => `${id} (${t.slice(0, 60)}…)`).join('; ') || 'none'}; added before: ${bang.known.join(', ') || 'none (nothing to name)'}; missing ${bang.missing.join(', ') || 'none'}; all change lists: ${lists.length}, ${lists.filter((o) => (o.list.relevant ?? []).length).length} with relevant IDs (${relevantIds.join(', ') || 'none'})`],
    ['T1b. usage.json counts that item as relevant (count ≥ 1)',
      bang.known.length === 0 || uncounted.length === 0,
      `${bang.known.map((id) => `${id}: ${JSON.stringify(usage?.[id] ?? null)}`).join('; ') || 'no item to count'}`],
    ['T2. usage.json exists and holds every F and A item added that is still live',
      usage !== null && addedFA.length > 0 && notInUsage.length === 0,
      `usage.json ${usage === null ? 'missing or unreadable' : `holds ${Object.keys(usage).join(', ') || 'nothing'}`}; live F/A added: ${addedFA.join(', ') || 'none'}; missing: ${notInUsage.join(', ') || 'none'}`],
  ].map(([name, pass, detail, soft]) => ({ name, pass: Boolean(pass), detail, soft: Boolean(soft) }));

  // T3: a session started after the run. A, resumed for one short turn: the memory block its
  // SessionStart hook returned (stream-json hook_response) has `# Topics` and each topic's slug
  // when a topic exists, and no such section when none does. The transcript is no source for it:
  // 2.1.308 doesn't add a SessionStart block identical to the last one already in the resumed
  // transcript (the model has it from there), and nothing changes memory between A's turn 5 and
  // this run. Whether it was added, and whether it matched, is reported as a note.
  const startedAfter = await (async () => {
    const lines = lineCount(A.transcript());
    const sessionStart = (list) => list.filter((e) => e.type === 'attachment' && e.attachment?.type === 'hook_additional_context'
      && e.attachment.hookEvent === 'SessionStart').map((e) => (e.attachment.content ?? []).join('\n'));
    const r = await run(bin, ['-p', 'Reply with only: ok', '--resume', A.id, ...common], { cwd: A.cwd, env, timeoutMs: TURN_TIMEOUT_MS });
    const { init, result } = parseStream(r.stdout);
    const all = entries(A.transcript());
    const block = hookContexts(r.stdout, 'SessionStart').find((t) => t.startsWith('# slate memory')) ?? null;
    const w = await waitCurator(A.dir);
    return {
      exit: r.code, guard: pluginGuard(init), result: result?.result ?? null, costUsd: result?.total_cost_usd ?? null,
      wallSec: secs(r.ms), curatorOk: w.ok, block,
      kept: sessionStart(all.slice(lines)).some((t) => t.startsWith('# slate memory')),
      sameAsLast: block !== null && sessionStart(all.slice(0, lines)).at(-1) === block,
    };
  })();
  const slugsAfter = Object.keys(topicTexts(slate));
  const blockTopics = /^# Topics$/m.test(startedAfter.block ?? '');
  checks.push({
    name: 'T3. the memory block of a session started after the run shows # Topics whenever a topic exists',
    pass: startedAfter.guard.ok && startedAfter.block !== null
      && (slugsAfter.length ? blockTopics && slugsAfter.every((slug) => startedAfter.block.includes(slug)) : !blockTopics),
    detail: `topics: ${slugsAfter.join(', ') || 'none'}; # Topics in the block: ${blockTopics}; resumed A: exit ${startedAfter.exit}, ${startedAfter.guard.ok ? 'guard ok' : startedAfter.guard.why}, block ${startedAfter.block === null ? 'MISSING' : `${startedAfter.block.length} chars`}; reply ${JSON.stringify(startedAfter.result)}`,
    soft: false,
  });
  checks.push({
    name: 'note: the harness kept that SessionStart block in the transcript (not asserted)',
    pass: true,
    detail: `kept ${startedAfter.kept}; identical to the last SessionStart block already in the transcript: ${startedAfter.sameAsLast}`,
    soft: true,
  });
  console.log(`started after the run: A resumed, ${startedAfter.wallSec}s, $${startedAfter.costUsd}, curator ${startedAfter.curatorOk ? 'settled' : 'NOT settled'}`);

  // A streamed session reports a running total; each -p run reports its own.
  const costs = Object.fromEntries([A, B].map((s) => [s.name, Math.round((s.turns.reduce((n, t) => n + (t.costUsd ?? 0), 0)
    + Math.max(0, ...s.turns.map((t) => t.cumulativeCostUsd ?? 0))) * 1000) / 1000]));
  const sessionResults = (s) => ({
    id: s.id, cwd: s.cwd, dir: s.dir, transcript: s.tp, turns: s.turns, costUsd: costs[s.name],
    agentCalls: s.a.agentCalls, toolResults: s.a.toolResults, notifications: s.a.notifications,
    hookContext: s.a.hookContext.map((h) => ({ ...h, text: h.text.slice(0, 600) })),
    linkCalls: s.linkCalls, subagentWrites: s.sub.writes, denials: s.denials, handbacks: s.hb, offloadEntries: s.entryChecks,
    now: s.now, curatorLog: s.log, session: readText(path.join(s.dir, 'session.json')), curated: readText(path.join(s.dir, 'curated.json')), queue: s.queue,
    curatorRuns: runsOf(s).map((r) => ({ ...r, start: iso(r.start), end: iso(r.end) })),
  });
  const results = {
    claude: { bin, version }, model: MODEL, home, slate, fileCount, aborted: ctx.aborted, costUsd: costs,
    checks, A: sessionResults(A), B: sessionResults(B),
    bReads, reportWrites, cwdChanges, userSlateChanges,
    memory: mem, topics, usage, ids, added, offloads: offloadsText,
    curatorOutputs: outputs, startedAfter: { ...startedAfter, topics: slugsAfter },
    subagentStops: probes, curatorChildren: children,
    reports: Object.fromEntries(reports.map((f) => [f, readText(path.join(reportsDir, f))])),
  };
  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  const { passed, total } = printChecks(checks);
  console.log(`\n${passed}/${total} checks passed; cost A $${costs.A}, B $${costs.B}, A resumed after $${startedAfter.costUsd} (curators not included)`);
  console.log(`results: ${out}`);
  console.log(`left in place: ${home}\n               ${projectA}\n               ${projectB}\n               ${probeDir}`);
  console.log(`               ${path.dirname(A.tp)}\n               ${path.dirname(B.tp)}`);
  process.exitCode = passed === total ? 0 : 1;
}

if (argv.includes('--recheck')) {
  recheck(path.resolve(argv[argv.indexOf('--recheck') + 1]));
} else if (argv.includes('--live')) {
  await main();
} else {
  const why = 'opt-in, real model calls: node test/live/acceptance.mjs --live (or --recheck <results.json>)';
  if (process.env.NODE_TEST_CONTEXT) (await import('node:test')).test('live acceptance', { skip: why });
  else console.log(`skipped (${why})`);
}
