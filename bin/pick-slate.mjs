#!/usr/bin/env node
// claude-slate's picker: node pick-slate.mjs <pid> [name]. Settles on a slate, asking only when it
// must, then leaves its name in the launch file that SessionStart in process <pid> reads.
// Exit 0: start claude. Exit 1: don't (stopped, or a question with no terminal to ask it on).
import { realpathSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  slateHome, validName, createSlate, listSlates, closest, writeLaunch, NAME_HELP,
} from '../plugins/slate/scripts/lib/slate.mjs';

export async function pick(argv, { home, input, output, interactive }) {
  const say = (s) => output.write(s);
  const [pidArg, name0 = ''] = argv;
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) {
    say('claude-slate: missing process ID\n');
    return 1;
  }
  let rl = null;
  let lines = null;
  const ask = async (question) => {
    if (!rl) {
      rl = readline.createInterface({ input, terminal: false });
      lines = rl[Symbol.asyncIterator]();
    }
    say(question);
    const { value, done } = await lines.next();
    return done ? '' : value.trim();
  };
  try {
    const slates = await listSlates(home);
    let name = name0;
    if (!name) {
      if (!slates.length) {
        say('No slates yet. Start one with: claude-slate <name>\n');
        return 1;
      }
      if (!interactive) {
        say('claude-slate: picking a slate needs a terminal; give a name instead\n');
        return 1;
      }
      slates.forEach((s, i) => say(`  ${i + 1}  ${s.name}\n`));
      const answer = await ask('Slate (number or new name): ');
      if (!answer) return 1;
      if (/^\d+$/.test(answer)) {
        const chosen = slates[Number(answer) - 1];
        if (!chosen) {
          say(`claude-slate: no slate ${answer} on the list\n`);
          return 1;
        }
        name = chosen.name;
      } else {
        name = answer;
      }
    }
    if (!validName(name)) {
      say(`claude-slate: ${NAME_HELP}\n`);
      return 1;
    }
    if (!slates.some((s) => s.name === name)) {
      if (!interactive) {
        say(`claude-slate: no slate named ${name}; creating one needs a terminal to confirm\n`);
        return 1;
      }
      const near = closest(name, slates);
      const answer = await ask(`Create slate ${name}?${near ? ` (closest: ${near})` : ''} [y/N] `);
      if (!/^y(es)?$/i.test(answer)) return 1;
      await createSlate(home, name);
    }
    await writeLaunch(home, pid, name);
    return 0;
  } finally {
    rl?.close();
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  let code;
  try {
    code = await pick(process.argv.slice(2), {
      home: slateHome(), input: process.stdin, output: process.stderr, interactive: Boolean(process.stdin.isTTY),
    });
  } catch (e) {
    process.stderr.write(`claude-slate: ${String(e?.message ?? e).replace(/\s+/g, ' ').trim()}\n`);
    code = 1;
  }
  process.exit(code);
}
