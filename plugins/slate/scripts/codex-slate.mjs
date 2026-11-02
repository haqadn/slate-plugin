import { run } from './slate.mjs';

const [command, ...args] = process.argv.slice(2);
const id = process.env.CODEX_THREAD_ID;
if (!id) {
  process.stderr.write('slate: CODEX_THREAD_ID is missing; run this command inside the Codex thread to link.\n');
  process.exitCode = 1;
} else {
  const { out } = await run([command, id, ...args], { ...process.env, SLATE_RUNTIME: 'codex' });
  process.stdout.write(out);
}
