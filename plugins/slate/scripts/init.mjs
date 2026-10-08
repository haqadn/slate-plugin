// /slate:init: create this session's folder and print the rules. Usage: init.mjs <sessionId>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSession, claudePid } from './lib/session.mjs';
import { rulesText } from './lib/inject.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function init(sessionId, { root, pid }) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId) || sessionId.includes('..')) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  }
  const { created, dir } = await initSession(root, sessionId, pid);
  return `${created ? 'slate on' : 'slate already active'}: ${dir}\n\n${await rulesText(dir)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    process.stdout.write(`${await init(process.argv[2], { root, pid: claudePid() })}\n`);
  } catch (e) {
    process.stderr.write(`slate init: ${e.message}\n`);
    process.exitCode = 1;
  }
}
