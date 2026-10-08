#!/usr/bin/env node
// Fake `claude` for curator tests. Records each call to $FAKE_RECORD (one JSON line) and edits
// the memory files named in the prompt, per $FAKE_MODE: good | bad | bad-then-good | fail | sleep | orphan.
import fs from 'node:fs';

const args = process.argv.slice(2);
// `node --test` also runs files under test/ as test files; without a prompt there is nothing to do.
if (!args.includes('-p')) process.exit(0);

const prompt = args[args.indexOf('-p') + 1];
const mode = process.env.FAKE_MODE || 'good';
const record = process.env.FAKE_RECORD;

let prior = 0;
if (record) {
  try {
    prior = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).length;
  } catch {}
  const stdinRdev = fs.fstatSync(0).rdev;
  const line = { args, prompt, env: process.env, cwd: process.cwd(), pid: process.pid, stdinRdev };
  fs.appendFileSync(record, `${JSON.stringify(line)}\n`);
}

const turn = Number(/^Current turn: (\d+)$/m.exec(prompt)?.[1]);
const fileFor = (name) => {
  const m = new RegExp(`^- (/.*/${name.replace('.', '\\.')})$`, 'm').exec(prompt);
  if (!m) throw new Error(`fake-claude: no path for ${name} in prompt`);
  return m[1];
};
const instructions = fileFor('instructions.md');
const superseded = fileFor('superseded.md');

function good() {
  const used = [instructions, superseded].flatMap((f) =>
    [...fs.readFileSync(f, 'utf8').matchAll(/\[I(\d+) /g)].map((m) => Number(m[1])));
  const next = Math.max(0, ...used) + 1;
  let text = fs.readFileSync(instructions, 'utf8');
  if (text && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(instructions, `${text}- [I${next} t${turn}] fake item\n`);
}

function bad() {
  const text = fs.readFileSync(instructions, 'utf8');
  fs.writeFileSync(instructions, text.replace(/^(- \[I1 t\d+\] .*)$/m, '$1 (reworded)'));
}

switch (mode) {
  case 'good':
    good();
    break;
  case 'bad':
    bad();
    break;
  case 'bad-then-good':
    if (prior === 0) bad();
    else good();
    break;
  case 'fail':
    // A crash after a partial edit; the runner must undo it, including a file it created.
    good();
    fs.writeFileSync(fileFor('now.md'), 'Goal: fake\n');
    process.stderr.write('fake-claude: failing on purpose\n');
    process.exit(1);
  case 'orphan': {
    // Leaves a process in its own group holding our stderr open, then succeeds.
    const { spawn } = await import('node:child_process');
    const o = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      detached: true, stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (record) fs.writeFileSync(`${record}.orphan`, String(o.pid));
    o.unref();
    good();
    break;
  }
  case 'sleep':
    await new Promise((r) => setTimeout(r, 3000));
    good();
    break;
  default:
    process.stderr.write(`fake-claude: unknown FAKE_MODE ${mode}\n`);
    process.exit(1);
}
