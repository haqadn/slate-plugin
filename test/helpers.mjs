// A session under SLATE_HOME-style `home`: slate `name` (made on first use) plus .sessions/<id>/.
import path from 'node:path';
import { createSlate, createSession, slateDir } from '../plugins/slate/scripts/lib/slate.mjs';

export async function initSession(home, id, pid, name = 'topic') {
  await createSlate(home, name);
  return createSession(slateDir(home, name), id, pid);
}

export const sessionDir = (home, id, name = 'topic') => path.join(home, name, '.sessions', id);
