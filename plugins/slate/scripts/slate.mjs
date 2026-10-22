// CLI behind /slate:link and /slate:done: node slate.mjs <list|link|done> <sessionId> [name] [--create] [--yes]
// The first stdout line is a status token, then free text. Always exits 0.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settle, spawnCurator, curatorWaitMs, currentPid } from './hook.mjs';
import { slateHome, validName, slateDir, slateOf, createSlate, createSession, listSlates, sessionDirs, findSession } from './lib/slate.mjs';
import { readSession, setPid, pendingTurns } from './lib/session.mjs';
import { memoryBlock } from './lib/inject.mjs';

const SWITCH_WAIT_MS = 5000; // for the old session's curator before it is aborted
const SAFE_ID = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const NAME_HELP = 'a slate name is lowercase letters, digits and hyphens, up to 64 characters, e.g. jetpack-seo';
const exists = (p) => fs.access(p).then(() => true, () => false);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function branchOf(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// The existing slate a new name may be a slip for: within edit distance 2, or a prefix either way.
function closest(name, slates) {
  let best = null;
  for (const { name: other } of slates) {
    const d = distance(name, other);
    if (d > 2 && !name.startsWith(other) && !other.startsWith(name)) continue;
    if (!best || d < best.d) best = { other, d };
  }
  return best?.other ?? null;
}

async function list(home, sid, cwd) {
  const own = await findSession(home, sid);
  const lines = [own ? `linked ${path.basename(slateOf(own))}` : 'unlinked'];
  for (const s of await listSlates(home)) lines.push(s.name);
  lines.push(`project: ${path.basename(cwd)}`);
  const branch = branchOf(cwd);
  if (branch) lines.push(`branch: ${branch}`);
  return { out: lines.join('\n') + '\n' };
}

// Set the old session folder aside, as /clear would have moved it: no curator running in it, no pid.
async function detach(old, env) {
  await settle(old, curatorWaitMs(env, SWITCH_WAIT_MS));
  const detached = `${old}.detached-${Date.now()}`;
  await fs.rename(old, detached);
  await setPid(detached, null);
  const pending = await pendingTurns(detached);
  return pending ? spawnCurator(detached, pending.to, env) : null;
}

async function link(home, sid, name, create, env) {
  if (!validName(name)) return { out: `error ${NAME_HELP}\n` };
  const slate = slateDir(home, name);
  if (!create && !(await exists(slate))) {
    const near = closest(name, await listSlates(home));
    return { out: `confirm-create ${name}${near ? ` closest ${near}` : ''}\n` };
  }
  await createSlate(home, name); // also repairs a slate a crash left half-made
  const old = await findSession(home, sid);
  let status = 'linked';
  let spawned = null;
  let dir;
  if (old && slateOf(old) === slate) {
    status = 'already-linked';
    dir = old;
  } else {
    if (old) {
      status = 'switched';
      spawned = await detach(old, env);
    }
    dir = (await createSession(slate, sid, currentPid(env))).dir;
  }
  return { out: `${status}\n${await memoryBlock(dir)}\n`, spawned };
}

// Aborts every curator in the slate, this session's and those of ended or detached sessions.
async function abortCurators(slate) {
  const sessions = path.join(slate, '.sessions');
  const ids = await fs.readdir(sessions).catch(() => []);
  for (const id of ids) await settle(path.join(sessions, id), 0);
}

async function done(home, sid, name, yes, env) {
  if (!yes) return { out: 'error confirmation required\n' };
  if (name === undefined) {
    const own = await findSession(home, sid);
    if (!own) return { out: 'error this session is not linked to a slate; give a name\n' };
    name = path.basename(slateOf(own));
  }
  if (!validName(name)) return { out: `error ${NAME_HELP}\n` };
  const slate = slateDir(home, name);
  if (!(await exists(slate))) return { out: `error no slate named ${name}\n` };
  const ownPid = currentPid(env);
  const live = [];
  for (const dir of await sessionDirs(home)) {
    const id = path.basename(dir);
    if (slateOf(dir) !== slate || id === sid) continue;
    const { pid } = await readSession(dir).catch(() => ({ pid: null }));
    if (pid && pid !== ownPid && alive(pid)) live.push(id.slice(0, 8));
  }
  if (live.length) return { out: `refused ${name} live ${live.join(',')}\n` };
  await abortCurators(slate);
  await fs.rm(slate, { recursive: true });
  return { out: `deleted ${name}\n` };
}

export async function run(argv, env = process.env, cwd = process.cwd()) {
  try {
    const flags = argv.filter((a) => a.startsWith('--'));
    const [command, sid, ...rest] = argv.filter((a) => !a.startsWith('--'));
    const home = slateHome(env);
    if (!['list', 'link', 'done'].includes(command)) return { out: 'error usage: slate.mjs <list|link|done> <session id> [name]\n' };
    if (typeof sid !== 'string' || !SAFE_ID.test(sid)) return { out: 'error missing or invalid session id\n' };
    // Words after the session id are one name: "Jetpack SEO" is rejected, not half-used.
    const name = rest.length ? rest.join(' ') : undefined;
    if (command === 'list') return await list(home, sid, cwd);
    if (command === 'link') return await link(home, sid, name ?? '', flags.includes('--create'), env);
    return await done(home, sid, name, flags.includes('--yes'), env);
  } catch (e) {
    return { out: `error ${String(e?.message ?? e).replace(/\s+/g, ' ').trim()}\n` };
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
  const { out } = await run(process.argv.slice(2));
  process.stdout.write(out);
  process.exitCode = 0;
}
