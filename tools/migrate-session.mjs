#!/usr/bin/env node
// One-off: copy an old per-project .slate/<session>/ folder into a shared slate. offloads.md's
// report paths are pointed at the slate; everything else is copied byte for byte.
// Usage: node tools/migrate-session.mjs <oldSessionDir> <name>   (honors SLATE_HOME)
import fs from 'node:fs/promises';
import path from 'node:path';
import { slateHome, validName, slateDir, createSlate } from '../plugins/slate/scripts/lib/slate.mjs';
import { lockHolder } from '../plugins/slate/scripts/lib/lock.mjs';

const SHARED = ['instructions.md', 'assumptions.md', 'facts.md', 'superseded.md', 'offloads.md', 'reports'];
const SESSION = ['now.md', 'session.json', 'curated.json', 'curator.log', 'queue', 'handbacks'];

function fail(msg) {
  console.error(`migrate: ${msg}`);
  process.exit(1);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Items in a file, or entries in a folder; null when missing.
async function count(p) {
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    return null;
  }
  if (st.isDirectory()) return (await fs.readdir(p)).length;
  const text = await fs.readFile(p, 'utf8');
  const lines = text.split('\n');
  const n = path.basename(p) === 'offloads.md'
    ? lines.filter((l) => /^## t\d+/.test(l)).length
    : lines.filter((l) => /^- \[[IAF]\d+\b/.test(l)).length;
  return n;
}

const [oldDir, name] = process.argv.slice(2);
if (!oldDir || !name) fail('usage: migrate-session.mjs <oldSessionDir> <name>');
if (!validName(name)) fail(`invalid name ${JSON.stringify(name)}: use a-z0-9 and single hyphens, at most 64 characters`);
const src = path.resolve(oldDir);
if (!(await fs.stat(src).catch(() => null))?.isDirectory()) fail(`not a folder: ${src}`);
const holder = await lockHolder(src);
if (holder !== null && alive(holder)) fail(`a curator (pid ${holder}) is running on ${src}; try again when it finishes`);

const home = slateHome();
const slate = slateDir(home, name);
if (await fs.stat(slate).catch(() => null)) fail(`slate already exists: ${slate}`);
const session = path.join(slate, '.sessions', path.basename(src));

// offloads.md names each report by its absolute path in the old folder, which the user deletes once
// migrated: point those at the slate's reports/, where they are copied. Both spellings of the old
// folder count, as given and with symlinks resolved; one can be the tail of the other (macOS /var
// and /private/var), so a match must start a path. Transcript paths, under ~/.claude, stay.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spellings = [...new Set([src, await fs.realpath(src)])].sort((a, b) => b.length - a.length);
const OLD_REPORTS = new RegExp(`(?<![\\w./~-])(?:${spellings.map(escape).join('|')})/reports/`, 'g');
async function copyOffloads(from, to) {
  const text = await fs.readFile(from, 'utf8');
  await fs.writeFile(to, text.replace(OLD_REPORTS, () => `${slate}/reports/`));
}

await createSlate(home, name);
await fs.mkdir(session, { recursive: true });
for (const [names, dest] of [[SHARED, slate], [SESSION, session]]) {
  for (const f of names) {
    const from = path.join(src, f);
    if (!(await fs.stat(from).catch(() => null))) continue;
    await fs.rm(path.join(dest, f), { recursive: true, force: true });
    if (f === 'offloads.md') await copyOffloads(from, path.join(dest, f));
    else await fs.cp(from, path.join(dest, f), { recursive: true });
    console.log(`${f.padEnd(16)} ${String(await count(from)).padStart(4)} ${String(await count(path.join(dest, f))).padStart(4)}`);
  }
}
console.log(`\ncounts: items per memory file, entries per folder (source, target)\nslate:   ${slate}\nsession: ${session}`);
