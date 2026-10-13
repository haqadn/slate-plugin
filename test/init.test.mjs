import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init } from '../plugins/slate/scripts/init.mjs';

const INIT = fileURLToPath(new URL('../plugins/slate/scripts/init.mjs', import.meta.url));
const temps = [];
after(async () => {
  for (const d of temps) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-init-'));
  temps.push(d);
  return d;
}
function run(args, env) {
  return new Promise((resolve) => {
    execFile('node', [INIT, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('init creates the folder and prints the rules with the real path; second run says already active', async () => {
  const root = await tmp();
  const dir = path.join(root, '.slate', 'sid-1');
  const first = await init('sid-1', { root, pid: 4242 });
  assert.match(first, new RegExp(`^slate on: ${dir}\\n\\n`));
  assert.ok(first.includes(`${dir}/instructions.md`) || first.includes(dir));
  assert.ok(!first.includes('{{dir}}'));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8')).pid, 4242);
  const second = await init('sid-1', { root, pid: 4242 });
  assert.match(second, new RegExp(`^slate already active: ${dir}\\n\\n`));
});

test('init rejects unsafe session ids', async () => {
  const root = await tmp();
  for (const bad of ['', '../x', 'a/b', '.', '..', 'a b', undefined]) {
    await assert.rejects(init(bad, { root, pid: 1 }), /session id/i, String(bad));
  }
  await assert.rejects(fs.access(path.join(root, '.slate')));
});

test('CLI: prints to stdout; bad or missing id exits 1 with a message', async () => {
  const root = await tmp();
  const ok = await run(['sid-2'], { CLAUDE_PROJECT_DIR: root, CLAUDE_PID: '4242' });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^slate on: /);
  const bad = await run(['../evil'], { CLAUDE_PROJECT_DIR: root });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /session id/i);
  const none = await run([], { CLAUDE_PROJECT_DIR: root });
  assert.equal(none.code, 1);
});
