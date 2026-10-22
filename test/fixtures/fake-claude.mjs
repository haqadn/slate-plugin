#!/usr/bin/env node
// Fake `claude` for curator tests. Records each call to $FAKE_RECORD (one JSON line, with `seen`,
// instructions.md as it read it) and prints a `--output-format json` result whose
// `structured_output` is a change list (`relevant` empty unless said), per $FAKE_MODE:
//   good             add "fake item <turn>"
//   relevant         add the key fact "fake fact <turn> (user)" with home general; relevant F1, F99
//   invalid          that add, plus an F item without a source
//   invalid-then-good
//   stale            first call: another session retires I1 (adding I4 "use bun") just after the
//                    read, and the list replaces I1; later calls replace the live "use bun" item
//   fail | garbage | no-structured   exit 1 | print non-JSON | a result without structured_output
//   sleep | hang     wait $FAKE_SLEEP_MS (default 3000 | 20000), then good
//   orphan           leave a process holding stderr open, then good
import fs from 'node:fs';

const args = process.argv.slice(2);
// `node --test` also runs files under test/ as test files; without a prompt there is nothing to do.
if (!args.includes('-p')) process.exit(0);

const prompt = args[args.indexOf('-p') + 1];
const mode = process.env.FAKE_MODE || 'good';
const record = process.env.FAKE_RECORD;

const turn = Number(/^Current turn: (\d+)$/m.exec(prompt)?.[1]);
const fileFor = (name) => {
  const m = new RegExp(`^- (/.*/${name.replace('.', '\\.')})$`, 'm').exec(prompt);
  if (!m) throw new Error(`fake-claude: no path for ${name} in prompt`);
  return m[1];
};
const instructions = fileFor('instructions.md');
const superseded = fileFor('superseded.md');
const seen = fs.readFileSync(instructions, 'utf8');

let prior = 0;
if (record) {
  try {
    prior = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).length;
  } catch {}
  const stdinRdev = fs.fstatSync(0).rdev;
  const line = { args, prompt, env: process.env, cwd: process.cwd(), pid: process.pid, stdinRdev, seen };
  fs.appendFileSync(record, `${JSON.stringify(line)}\n`);
}

const GOOD = [{ op: 'add', type: 'I', text: `fake item ${turn}` }];
const INVALID = [...GOOD, { op: 'add', type: 'F', text: 'an unsourced fact' }];

function reply(ops, relevant = []) {
  const out = { ops, relevant };
  const result = { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function stale() {
  if (prior > 0) {
    const id = /^- \[(I\d+) [^\]]*\] use bun$/m.exec(seen)?.[1];
    return [{ op: 'replace', id, text: 'use pnpm', reason: 'user switched to pnpm' }];
  }
  fs.writeFileSync(instructions, seen.replace('- [I1 t1] use npm\n', '- [I4 t3@0ther000] use bun\n'));
  fs.appendFileSync(superseded, '- [I1 t1 retired t3@0ther000] use npm (reason: other session chose bun)\n');
  return [{ op: 'replace', id: 'I1', text: 'use pnpm', reason: 'user switched to pnpm' }];
}

const sleep = (fallback) => new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_MS) || fallback));

switch (mode) {
  case 'good':
    reply(GOOD);
    break;
  case 'relevant':
    reply([{ op: 'add', type: 'F', text: `fake fact ${turn} (user)`, home: 'general' }], ['F1', 'F99']);
    break;
  case 'invalid':
    reply(INVALID);
    break;
  case 'invalid-then-good':
    reply(prior === 0 ? INVALID : GOOD);
    break;
  case 'stale':
    reply(stale());
    break;
  case 'fail':
    process.stderr.write('fake-claude: failing on purpose\n');
    process.exit(1);
  case 'garbage':
    process.stdout.write('this is not JSON\n');
    break;
  case 'no-structured':
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })}\n`);
    break;
  case 'orphan': {
    // Leaves a process in its own group holding our stderr open, then succeeds.
    const { spawn } = await import('node:child_process');
    const o = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      detached: true, stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (record) fs.writeFileSync(`${record}.orphan`, String(o.pid));
    o.unref();
    reply(GOOD);
    break;
  }
  case 'sleep':
    await sleep(3000);
    reply(GOOD);
    break;
  case 'hang':
    await sleep(20000);
    reply(GOOD);
    break;
  default:
    process.stderr.write(`fake-claude: unknown FAKE_MODE ${mode}\n`);
    process.exit(1);
}
