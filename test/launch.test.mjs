// claude-slate: the picker writes <SLATE_HOME>/.launch/<pid>; SessionStart in that process links the session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../plugins/slate/scripts/hook.mjs';
import { readSession } from '../plugins/slate/scripts/lib/session.mjs';
import { createSlate, createSession, findSession } from '../plugins/slate/scripts/lib/slate.mjs';
import { pick } from '../bin/pick-slate.mjs';
import { initSession, sessionDir } from './helpers.mjs';

const WRAPPER = fileURLToPath(new URL('../bin/claude-slate', import.meta.url));
const PID = 424242;
const MIN = 60 * 1000;

for (const k of ['SLATE_HOME', 'CLAUDE_PID', 'SLATE_CURATOR', 'SLATE_RUNTIME', 'SLATE_CLAUDE_BIN', 'CLAUDE_CODE_EXECPATH']) {
  delete process.env[k];
}

const temps = [];
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});

async function home() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-launch-'));
  temps.push(root);
  return root;
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const launchFile = (root, pid = PID) => path.join(root, '.launch', String(pid));
async function writeLaunchFile(root, name, pid = PID) {
  await fs.mkdir(path.join(root, '.launch'), { recursive: true });
  await fs.writeFile(launchFile(root, pid), `${name}\n`);
}
const start = (id, root, source) => ({ hook_event_name: 'SessionStart', session_id: id, cwd: root, source });
const envFor = (root, extra = {}) => ({ ...process.env, SLATE_HOME: root, CLAUDE_PID: String(PID), ...extra });
const ctx = (r) => r.output?.hookSpecificOutput?.additionalContext;
const said = (r) => r.output?.systemMessage;

// --- SessionStart reads the launch file ---

test('startup with a launch file for this process: linked before the first prompt, and it says so', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo');
  const r = await handle('SessionStart', start('new', root, 'startup'), envFor(root));
  const dir = sessionDir(root, 'new', 'jetpack-seo');
  assert.equal((await readSession(dir)).pid, PID);
  assert.ok(ctx(r).startsWith('# slate memory'));
  assert.equal(said(r), 'Linked to slate jetpack-seo.');
  assert.equal(await exists(launchFile(root)), false, 'the launch file is used up');
});

test('a launch file for another process is left alone: a claude started inside the session is not linked', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo', 111);
  const r = await handle('SessionStart', start('inner', root, 'startup'), envFor(root));
  assert.equal(r.output, null);
  assert.equal(await findSession(root, 'inner'), null);
  assert.ok(await exists(launchFile(root, 111)));
});

test('the launch file is used once: a later in-process /resume to an unlinked session stays unlinked', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo');
  await handle('SessionStart', start('A', root, 'startup'), envFor(root));
  const r = await handle('SessionStart', start('B', root, 'resume'), envFor(root));
  assert.equal(r.output, null);
  assert.equal(await findSession(root, 'B'), null);
});

test('resume from the command line links an unlinked session', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo');
  const r = await handle('SessionStart', start('old', root, 'resume'), envFor(root));
  assert.equal((await readSession(sessionDir(root, 'old', 'jetpack-seo'))).pid, PID);
  assert.equal(said(r), 'Linked to slate jetpack-seo.');
});

test('resume of a session on another slate keeps it there and says how to switch', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  const { dir } = await initSession(root, 'sid', 1, 'other');
  await writeLaunchFile(root, 'jetpack-seo');
  const r = await handle('SessionStart', start('sid', root, 'resume'), envFor(root));
  assert.equal(await findSession(root, 'sid'), dir);
  assert.ok(ctx(r).startsWith('# slate memory'));
  assert.equal(said(r), 'This session stays on slate other. Run /slate:link jetpack-seo to switch.');
  assert.equal(await exists(launchFile(root)), false);
});

test('resume of a session already on the launch slate says it is linked', async () => {
  const root = await home();
  await initSession(root, 'sid', 1, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo');
  const r = await handle('SessionStart', start('sid', root, 'resume'), envFor(root));
  assert.equal((await readSession(sessionDir(root, 'sid', 'jetpack-seo'))).pid, PID);
  assert.equal(said(r), 'Linked to slate jetpack-seo.');
});

test('a launch file naming a missing slate links nothing and says how to create it', async () => {
  const root = await home();
  await writeLaunchFile(root, 'ghost');
  const r = await handle('SessionStart', start('new', root, 'startup'), envFor(root));
  assert.equal(ctx(r), undefined);
  assert.equal(said(r), 'No slate named ghost. Run /slate:link ghost to create it.');
  assert.equal(await exists(path.join(root, 'ghost')), false);
  assert.equal(await findSession(root, 'new'), null);
});

test('a launch file with an unsafe name is ignored and removed', async () => {
  const root = await home();
  await writeLaunchFile(root, '../outside');
  const r = await handle('SessionStart', start('new', root, 'startup'), envFor(root));
  assert.equal(r.output, null);
  assert.equal(await exists(launchFile(root)), false);
  assert.equal(await exists(path.join(path.dirname(root), 'outside')), false);
});

test('a launch file older than 10 minutes is ignored and removed: its process ID may have been reused', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo');
  const t = new Date(Date.now() - 11 * MIN);
  await fs.utimes(launchFile(root), t, t);
  const r = await handle('SessionStart', start('new', root, 'startup'), envFor(root));
  assert.equal(r.output, null);
  assert.equal(await findSession(root, 'new'), null);
  assert.equal(await exists(launchFile(root)), false);
});

test('clear, compact and fork never use the launch file', async () => {
  for (const source of ['clear', 'compact', 'fork']) {
    const root = await home();
    await createSlate(root, 'jetpack-seo');
    await writeLaunchFile(root, 'jetpack-seo');
    const r = await handle('SessionStart', start('new', root, source), envFor(root));
    assert.equal(r.output, null, source);
    assert.equal(await findSession(root, 'new'), null, source);
    assert.ok(await exists(launchFile(root)), source);
  }
});

test('Codex never uses the launch file: its process ID is shared by threads', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo');
  const r = await handle('SessionStart', start('new', root, 'startup'), envFor(root, { SLATE_RUNTIME: 'codex' }));
  assert.equal(r.output, null);
  assert.ok(await exists(launchFile(root)));
});

// --- the picker ---

// Runs the picker with typed answers; returns its exit code, what it printed, and the launch file.
async function runPick(root, args, answers = [], { interactive = true } = {}) {
  let printed = '';
  const output = new Writable({
    write(chunk, _enc, cb) {
      printed += chunk;
      cb();
    },
  });
  const input = Readable.from(answers.map((a) => `${a}\n`));
  const code = await pick([String(PID), ...args], { home: root, input, output, interactive });
  const launch = await fs.readFile(launchFile(root), 'utf8').catch(() => null);
  return { code, printed, launch };
}

test('pick: an existing slate writes the launch file without asking', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  const r = await runPick(root, ['jetpack-seo'], [], { interactive: false });
  assert.equal(r.code, 0);
  assert.equal(r.launch, 'jetpack-seo\n');
  assert.equal(r.printed, '');
});

test('pick: a new name asks, naming the closest slate; yes creates it', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  const r = await runPick(root, ['jetpack-sep'], ['y']);
  assert.match(r.printed, /Create slate jetpack-sep\? \(closest: jetpack-seo\)/);
  assert.equal(r.code, 0);
  assert.ok(await exists(path.join(root, 'jetpack-sep', 'instructions.md')));
  assert.equal(r.launch, 'jetpack-sep\n');
});

test('pick: a new name with no answer creates nothing and stops', async () => {
  const root = await home();
  const r = await runPick(root, ['brand-new'], ['']);
  assert.match(r.printed, /Create slate brand-new\?/);
  assert.doesNotMatch(r.printed, /closest/);
  assert.equal(r.code, 1);
  assert.equal(await exists(path.join(root, 'brand-new')), false);
  assert.equal(r.launch, null);
});

test('pick: an invalid name is refused with the naming rule', async () => {
  const root = await home();
  const r = await runPick(root, ['Jetpack SEO'], ['y']);
  assert.equal(r.code, 1);
  assert.match(r.printed, /lowercase letters, digits and hyphens/);
  assert.deepEqual(await fs.readdir(root), []);
});

async function twoSlates() {
  const root = await home();
  const old = await createSlate(root, 'old-one');
  const fresh = await createSlate(root, 'fresh');
  const so = await createSession(old.dir, 'sid-old', 1);
  await createSession(fresh.dir, 'sid-new', 1);
  const t = new Date(Date.now() - MIN);
  await fs.utimes(path.join(so.dir, 'session.json'), t, t);
  return root;
}

test('pick: no name lists slates most recent first; a number picks one', async () => {
  const root = await twoSlates();
  const r = await runPick(root, [], ['2']);
  assert.match(r.printed, /1\s+fresh\n\s*2\s+old-one\n/);
  assert.equal(r.code, 0);
  assert.equal(r.launch, 'old-one\n');
});

test('pick: no name, then a typed existing name picks it', async () => {
  const root = await twoSlates();
  const r = await runPick(root, [], ['fresh']);
  assert.equal(r.code, 0);
  assert.equal(r.launch, 'fresh\n');
});

test('pick: no name, then a typed new name asks to create it', async () => {
  const root = await twoSlates();
  const r = await runPick(root, [], ['third', 'y']);
  assert.match(r.printed, /Create slate third\?/);
  assert.equal(r.code, 0);
  assert.ok(await exists(path.join(root, 'third', 'facts.md')));
  assert.equal(r.launch, 'third\n');
});

test('pick: no name and an empty answer, or a number not on the list, stops', async () => {
  for (const answer of ['', '3']) {
    const root = await twoSlates();
    const r = await runPick(root, [], [answer]);
    assert.equal(r.code, 1, JSON.stringify(answer));
    assert.equal(r.launch, null, JSON.stringify(answer));
  }
});

test('pick: no name and no slates says how to start one', async () => {
  const root = await home();
  const r = await runPick(root, [], []);
  assert.equal(r.code, 1);
  assert.match(r.printed, /claude-slate <name>/);
});

test('pick: a question without a terminal stops instead of waiting', async () => {
  const root = await twoSlates();
  for (const args of [[], ['brand-new']]) {
    const r = await runPick(root, args, ['y'], { interactive: false });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.printed, /terminal/);
    assert.equal(r.launch, null);
  }
  assert.equal(await exists(path.join(root, 'brand-new')), false);
});

test('pick: launch files older than 10 minutes are cleared; recent ones of other processes stay', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await writeLaunchFile(root, 'jetpack-seo', 111);
  await writeLaunchFile(root, 'jetpack-seo', 222);
  const t = new Date(Date.now() - 11 * MIN);
  await fs.utimes(launchFile(root, 111), t, t);
  await runPick(root, ['jetpack-seo'], [], { interactive: false });
  assert.equal(await exists(launchFile(root, 111)), false);
  assert.ok(await exists(launchFile(root, 222)));
});

// --- the claude-slate wrapper ---

// A fake `claude` that records its process ID and arguments, one per line.
async function fakeClaudeDir() {
  const dir = await home();
  const record = path.join(dir, 'record');
  await fs.writeFile(path.join(dir, 'claude'), `#!/bin/sh\n{ echo $$; for a in "$@"; do echo "$a"; done; } > '${record}'\n`, {
    mode: 0o755,
  });
  return { dir, record };
}

function wrapper(bin, args, root, fake) {
  return new Promise((resolve) => {
    const env = { ...process.env, SLATE_HOME: root, PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` };
    const child = execFile(bin, args, { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
}

test('claude-slate <name> [args]: claude runs in the same process with the other args; the launch file names it', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  const fake = await fakeClaudeDir();
  const r = await wrapper(WRAPPER, ['jetpack-seo', '-c', '--model', 'opus'], root, fake);
  assert.equal(r.code, 0, r.stderr);
  const [pid, ...args] = (await fs.readFile(fake.record, 'utf8')).trim().split('\n');
  assert.deepEqual(args, ['-c', '--model', 'opus']);
  assert.equal(await fs.readFile(launchFile(root, pid), 'utf8'), 'jetpack-seo\n');
});

test('claude-slate works through a symlink, as installed in ~/bin', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  const fake = await fakeClaudeDir();
  const bin = path.join(await home(), 'claude-slate');
  await fs.symlink(WRAPPER, bin);
  const r = await wrapper(bin, ['jetpack-seo'], root, fake);
  assert.equal(r.code, 0, r.stderr);
  const [pid, ...args] = (await fs.readFile(fake.record, 'utf8')).trim().split('\n');
  assert.deepEqual(args, []);
  assert.ok(await exists(launchFile(root, pid)));
});

test('claude-slate: when the picker stops, claude never starts', async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  const fake = await fakeClaudeDir();
  for (const args of [['-c'], ['brand-new'], []]) {
    const r = await wrapper(WRAPPER, args, root, fake);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(await exists(fake.record), false, args.join(' '));
  }
});

// --- zsh tab completion ---

const COMPLETION = fileURLToPath(new URL('../bin/claude-slate.zsh', import.meta.url));
const zsh = await new Promise((r) => execFile('zsh', ['-fc', 'exit 0'], (err) => r(!err)));

function zshRun(script, root) {
  return new Promise((resolve) => {
    execFile('zsh', ['-fc', script], { env: { ...process.env, SLATE_HOME: root } }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

test('zsh completion: the first word completes to slate names only', { skip: !zsh && 'no zsh' }, async () => {
  const root = await home();
  await createSlate(root, 'jetpack-seo');
  await createSlate(root, 'other');
  await writeLaunchFile(root, 'other');
  await fs.writeFile(path.join(root, 'notes.txt'), '');
  const stubAdd = 'compadd() { while [[ $# -gt 0 && $1 != -- ]]; do shift; done; shift; print -rl -- "$@"; }';
  const r = await zshRun(`compdef() { :; }; source '${COMPLETION}'; ${stubAdd}; CURRENT=2; _claude_slate`, root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['jetpack-seo', 'other']);
});

test('zsh completion: registers for claude-slate, and sourcing before compinit is harmless', { skip: !zsh && 'no zsh' }, async () => {
  const root = await home();
  const a = await zshRun(`compdef() { print -r -- "compdef $*"; }; source '${COMPLETION}'`, root);
  assert.equal(a.stdout.trim(), 'compdef _claude_slate claude-slate');
  const b = await zshRun(`source '${COMPLETION}'`, root);
  assert.equal(b.code, 0);
  assert.equal(b.stderr, '');
});
