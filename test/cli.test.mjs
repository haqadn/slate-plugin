import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../plugins/slate/scripts/slate.mjs';
import { findSession, createSlate, createSession } from '../plugins/slate/scripts/lib/slate.mjs';
import { readSession, nextTurn, writeMessage, appendAnswer } from '../plugins/slate/scripts/lib/session.mjs';

const CLI = fileURLToPath(new URL('../plugins/slate/scripts/slate.mjs', import.meta.url));
const CURATE = fileURLToPath(new URL('../plugins/slate/scripts/curate.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const temps = [];
const kids = [];
after(async () => {
  for (const k of kids) {
    try {
      process.kill(k, 'SIGKILL');
    } catch {}
  }
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
const exists = (p) => fs.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-cli-'));
  temps.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'myproject');
  await fs.mkdir(cwd);
  const env = { ...process.env, SLATE_HOME: home, CLAUDE_PID: String(process.pid), SLATE_CLAUDE_BIN: FAKE, FAKE_MODE: 'good' };
  return { root, home, cwd, env };
}

// The CLI as a child process, the way the skills run it.
function cli(s, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: s.cwd, env: { ...s.env, ...env } }, (err, stdout, stderr) => {
      resolve({ out: stdout, first: stdout.split('\n')[0], code: err?.code ?? 0, stderr });
    });
  });
}

const FAR_PID = String(process.ppid); // alive, and not this process

test('list: linked or unlinked, slates most recent first, project line', async () => {
  const s = await setup();
  const old = await createSlate(s.home, 'old-one');
  const fresh = await createSlate(s.home, 'fresh');
  const so = await createSession(old.dir, 'sid-old', 1);
  await createSession(fresh.dir, 'sid-new', 1);
  const t = new Date(Date.now() - 60000);
  await fs.utimes(path.join(so.dir, 'session.json'), t, t);
  const a = await cli(s, ['list', 'nobody']);
  assert.deepEqual(a.out.split('\n').filter(Boolean), ['unlinked', 'fresh', 'old-one', 'project: myproject']);
  const b = await cli(s, ['list', 'sid-old']);
  assert.deepEqual(b.out.split('\n').filter(Boolean), ['linked old-one', 'fresh', 'old-one', 'project: myproject']);
  assert.equal(a.code, 0);
});

test('list: branch line when the project is a git checkout', async () => {
  const s = await setup();
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: s.cwd });
  const r = await cli(s, ['list', 'nobody']);
  assert.deepEqual(r.out.split('\n').filter(Boolean), ['unlinked', 'project: myproject', 'branch: feat/x']);
});

test('list: an empty home lists no slates', async () => {
  const s = await setup();
  assert.deepEqual((await cli(s, ['list', 'x'])).out.split('\n').filter(Boolean), ['unlinked', 'project: myproject']);
});

test('link: existing slate -> linked with rules and block; the session folder exists', async () => {
  const s = await setup();
  await createSlate(s.home, 'jetpack-seo');
  const r = await cli(s, ['link', 'sid-1', 'jetpack-seo']);
  assert.equal(r.first, 'linked');
  const dir = path.join(s.home, 'jetpack-seo', '.sessions', 'sid-1');
  assert.equal(await findSession(s.home, 'sid-1'), dir);
  assert.equal((await readSession(dir)).pid, process.pid);
  assert.match(r.out, /# slate memory/);
  assert.ok(r.out.includes(`Slate (shared with other sessions): ${path.join(s.home, 'jetpack-seo')}. Session: ${dir}.`));
  assert.match(r.out, /Reply like a colleague/);
});

test('link: a new name needs --create; closest existing name is offered; nothing is made without it', async () => {
  const s = await setup();
  await createSlate(s.home, 'jetpack-se0');
  const r = await cli(s, ['link', 'sid-1', 'jetpack-seo']);
  assert.equal(r.first, 'confirm-create jetpack-seo closest jetpack-se0');
  assert.deepEqual(await fs.readdir(s.home), ['jetpack-se0']);
  assert.equal(await findSession(s.home, 'sid-1'), null);

  const p = await cli(s, ['link', 'sid-1', 'jetpack']);
  assert.equal(p.first, 'confirm-create jetpack closest jetpack-se0', 'a prefix counts');
  const none = await cli(s, ['link', 'sid-1', 'zzzz-unrelated']);
  assert.equal(none.first, 'confirm-create zzzz-unrelated');
  assert.deepEqual(await fs.readdir(s.home), ['jetpack-se0']);

  const made = await cli(s, ['link', 'sid-1', 'jetpack-seo', '--create']);
  assert.equal(made.first, 'linked');
  assert.ok(await exists(path.join(s.home, 'jetpack-seo', 'reports')));
  assert.ok(await findSession(s.home, 'sid-1'));
  const again = await cli(s, ['link', 'sid-1', 'jetpack-seo']);
  assert.equal(again.first, 'already-linked');
  assert.match(again.out, /# slate memory/);
  assert.match(again.out, /Reply like a colleague/);
});

test('link: switching detaches the old folder (pid null) and links the new slate', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  await createSlate(s.home, 'beta');
  await createSession(a.dir, 'sid-1', process.pid);
  const r = await cli(s, ['link', 'sid-1', 'beta']);
  assert.equal(r.first, 'switched');
  const sessions = await fs.readdir(path.join(a.dir, '.sessions'));
  assert.equal(sessions.length, 1);
  assert.match(sessions[0], /^sid-1\.detached-\d+$/);
  assert.equal((await readSession(path.join(a.dir, '.sessions', sessions[0]))).pid, null);
  assert.equal(await findSession(s.home, 'sid-1'), path.join(s.home, 'beta', '.sessions', 'sid-1'));
  assert.match(r.out, /# slate memory/);
});

test('link: switching with a pending turn drains the detached folder', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  await createSlate(s.home, 'beta');
  const old = (await createSession(a.dir, 'sid-1', process.pid)).dir;
  const turn = await nextTurn(old, { lastKind: 'user' });
  await writeMessage(old, turn, 'use pnpm');
  await appendAnswer(old, turn, 'ok');
  const r = await run(['link', 'sid-1', 'beta'], s.env, s.cwd);
  assert.match(r.out, /^switched\n/);
  const [detached] = await fs.readdir(path.join(a.dir, '.sessions'));
  const dir = path.join(a.dir, '.sessions', detached);
  assert.deepEqual(r.spawned, [CURATE, dir, '1', 'sonnet']);
  for (let i = 0; i < 200 && !(await exists(path.join(dir, 'curated.json'))); i++) await sleep(50);
  assert.ok(await exists(path.join(dir, 'curated.json')), 'the drain ran');
  for (let i = 0; i < 100 && (await exists(path.join(dir, 'curator.lock'))); i++) await sleep(50);
});

test('link: switching with nothing pending spawns nothing', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  await createSlate(s.home, 'beta');
  await createSession(a.dir, 'sid-1', process.pid);
  const r = await run(['link', 'sid-1', 'beta'], s.env, s.cwd);
  assert.equal(r.spawned, null);
});

// Review focus 5: bad names from the picker's free-text box.
test('link: bad names give a one-line error naming the allowed form and create nothing', async () => {
  const s = await setup();
  await fs.mkdir(s.home);
  for (const bad of ['Jetpack SEO', '../x', '', 'a'.repeat(200)]) {
    for (const flags of [[], ['--create']]) {
      const r = await cli(s, ['link', 'sid-1', bad, ...flags]);
      assert.match(r.first, /^error .*lowercase letters, digits and hyphens/, JSON.stringify(bad));
      assert.equal(r.out.trim().split('\n').length, 1);
    }
  }
  const multi = await cli(s, ['link', 'sid-1', 'Jetpack', 'SEO']);
  assert.match(multi.first, /^error /);
  assert.deepEqual(await fs.readdir(s.home), []);
  assert.deepEqual((await fs.readdir(path.dirname(s.home))).sort(), ['home', 'myproject']);
});

test('link: an unsafe session id is an error', async () => {
  const s = await setup();
  await createSlate(s.home, 'alpha');
  const r = await cli(s, ['link', '../evil', 'alpha']);
  assert.match(r.first, /^error /);
  assert.deepEqual(await fs.readdir(path.join(s.home, 'alpha', '.sessions')), []);
});

test('done: without --yes it only asks for confirmation', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  const r = await cli(s, ['done', 'sid-1', 'alpha']);
  assert.equal(r.first, 'error confirmation required');
  assert.ok(await exists(a.dir));
});

test('done: a live peer session refuses; the slate stays', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  await createSession(a.dir, 'peer-session-1', Number(FAR_PID));
  await createSession(a.dir, 'sid-1', process.pid);
  const r = await cli(s, ['done', 'sid-1', 'alpha', '--yes']);
  assert.equal(r.first, 'refused alpha live peer-ses');
  assert.ok(await exists(a.dir));
});

test('done: this session, a dead peer and this process\'s own pid are not live peers', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.on('exit', r));
  await createSession(a.dir, 'sid-1', process.pid);
  await createSession(a.dir, 'branch-of-me', process.pid);
  await createSession(a.dir, 'dead-peer', dead.pid);
  await createSession(a.dir, 'no-pid', null);
  await createSession(a.dir, 'sid-1.detached-5', Number(FAR_PID)); // detached folders are not sessions
  const r = await cli(s, ['done', 'sid-1', '--yes']); // name defaults to this session's slate
  assert.equal(r.first, 'deleted alpha');
  assert.equal(await exists(a.dir), false);
});

test('done: unknown slate, bad name and no slate for this session are errors', async () => {
  const s = await setup();
  await createSlate(s.home, 'alpha');
  assert.match((await cli(s, ['done', 'sid-1', 'nope', '--yes'])).first, /^error /);
  assert.match((await cli(s, ['done', 'sid-1', '../alpha', '--yes'])).first, /^error /);
  assert.match((await cli(s, ['done', 'sid-1', '--yes'])).first, /^error /);
  assert.ok(await exists(path.join(s.home, 'alpha')));
});

// Review focus 4: /slate:done while a curator is mid-run.
test('done: a running curator (this session\'s or an ended one\'s) is SIGTERMed, then the slate is gone for good', async () => {
  const s = await setup();
  const a = await createSlate(s.home, 'alpha');
  const mine = (await createSession(a.dir, 'sid-1', process.pid)).dir;
  const ended = (await createSession(a.dir, 'ended-1', null)).dir;
  const bin = path.join(s.root, 'bin');
  await fs.mkdir(bin);
  // A stand-in curator: its command line names curate.mjs, it holds the lock and dies on SIGTERM.
  await fs.writeFile(path.join(bin, 'curate.mjs'), 'setInterval(() => {}, 1000);\n');
  const holders = [];
  for (const dir of [mine, ended]) {
    const child = spawn(process.execPath, [path.join(bin, 'curate.mjs'), dir, '1'], { stdio: 'ignore' });
    kids.push(child.pid);
    holders.push(new Promise((r) => child.on('exit', (code, signal) => r(signal))));
    await fs.writeFile(path.join(dir, 'curator.lock'), `${child.pid} nonce\n`);
  }
  const r = await cli(s, ['done', 'sid-1', 'alpha', '--yes']);
  assert.equal(r.first, 'deleted alpha');
  assert.deepEqual(await Promise.all(holders), ['SIGTERM', 'SIGTERM']);
  assert.equal(await exists(a.dir), false);
  await sleep(300);
  assert.equal(await exists(a.dir), false, 'nothing recreates it');
});

test('unknown command and missing session id are errors, exit 0', async () => {
  const s = await setup();
  const a = await cli(s, ['bogus', 'x']);
  assert.match(a.first, /^error /);
  assert.match((await cli(s, [])).first, /^error /);
  assert.equal(a.code, 0);
});
