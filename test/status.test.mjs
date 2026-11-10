import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../plugins/slate/scripts/slate.mjs';
import { createSlate } from '../plugins/slate/scripts/lib/slate.mjs';

const PLUGIN = fileURLToPath(new URL('../plugins/slate', import.meta.url));
const hasClaude = spawnSync('claude', ['--version']).status === 0;

// The row's behaviour is tested in plugins/slate/test/status.test.tsx: it needs Claude Code's own harness.
test('the slate row passes its Claude Code tests', { skip: !hasClaude && 'claude is not on PATH' }, () => {
  const r = spawnSync('claude', ['plugin', 'test', PLUGIN], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the slate row never touches the statusLine setting', async () => {
  const src = await fs.readFile(`${PLUGIN}/hooks/status.tsx`, 'utf8');
  assert.doesNotMatch(src, /\$\.settings|\$\.ui\.status/);
});

test('digest: the project, then each slate with capped facts and topic summaries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-digest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'myproject');
  await fs.mkdir(cwd);
  const alpha = await createSlate(home, 'alpha');
  await createSlate(home, 'beta');
  await fs.writeFile(path.join(alpha.dir, 'facts.md'), `F1 alpha fact ${'x'.repeat(5000)}\n`);
  await fs.mkdir(path.join(alpha.dir, 'topics'), { recursive: true });
  await fs.writeFile(path.join(alpha.dir, 'topics', 'auth.md'), '# Auth\n> Login flows\n');

  const { out } = await run(['digest', 'sid'], { SLATE_HOME: home }, cwd);

  const lines = out.split('\n');
  assert.equal(lines[0], 'digest');
  assert.equal(lines[1], 'project: myproject');
  assert.ok(lines.includes('## alpha'));
  assert.ok(lines.includes('## beta'));
  assert.ok(lines.includes('- Auth: Login flows'));
  assert.match(out, /F1 alpha fact x+/);
  assert.ok(out.length < 2000, `digest is ${out.length} chars`);
});
