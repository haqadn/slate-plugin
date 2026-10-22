import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = `${ROOT}plugins/slate/`;
const json = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
const exists = (f) => fs.access(f).then(() => true, () => false);

test('plugin.json and marketplace.json agree and carry userConfig.curatorModel', async () => {
  const plugin = await json(`${PLUGIN}.claude-plugin/plugin.json`);
  const market = await json(`${ROOT}.claude-plugin/marketplace.json`);
  assert.equal(plugin.name, 'slate');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.ok(plugin.description);
  assert.equal(market.name, 'slate-plugin');
  assert.deepEqual(market.plugins.map((p) => p.name), [plugin.name]);
  assert.equal(market.plugins[0].source, './plugins/slate');
  const opt = plugin.userConfig.curatorModel;
  assert.equal(opt.type, 'string');
  assert.equal(opt.default, 'sonnet');
  assert.ok(opt.title && opt.description);
});

test('hooks.json wraps six events (seven commands) and every plugin-root path exists', async () => {
  const cfg = await json(`${PLUGIN}hooks/hooks.json`);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
  const cmds = Object.values(cfg.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.length, 7);
  for (const c of cmds) {
    for (const [, rel] of c.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
      assert.ok(await exists(PLUGIN + rel), rel);
    }
  }
});

test('agent frontmatter', async () => {
  const agent = await fs.readFile(`${PLUGIN}agents/offload.md`, 'utf8');
  assert.match(agent, /^---\nname: offload\n/);
  assert.match(agent, /description: .+/);
  const description = /^description: (.+)$/m.exec(agent)[1];
  assert.match(description, /^slate sessions only\b.*~\/slate\//i, 'other sessions should not pick the agent');
  assert.ok(description.length <= 250, `description is ${description.length} chars`);
  assert.doesNotMatch(description, /: /, 'a plain YAML scalar');
  assert.doesNotMatch(agent.split('\n---')[0], /^tools:/m);
  assert.match(agent, /hand-back tool.*600|600.*hand-back tool/i, 'the return limit also covers a hand-back message');
  assert.match(agent, /\.jsonl.*transcript|transcript.*\.jsonl/i, 'a past run is reachable through its transcript path');
  assert.match(agent, /never overwrite an existing report/i);
  assert.match(agent, /topic files named in your brief/i, 'an offload reads the topic files its brief names');
  // Recent Claude Code has no Grep or Glob tool, and Bash on slate paths is denied in the default
  // permission mode (live acceptance, 2.1.308): an `ls` of reports/ sank the whole offload.
  assert.match(agent, /Write won't replace a file you haven't read/, 'no pre-check of reports/: Write itself guards');
  assert.doesNotMatch(agent, /if the path exists/i, 'a pre-check invites `ls reports/`');
  assert.match(agent, /slate files[^\n]*only Read and Write[^\n]*Bash[^\n]*denied/i, 'no Bash on slate paths');
  assert.match(agent, /offloads\.md[^\n]*report/i, 'past reports are found through offloads.md');
  assert.doesNotMatch(agent, /Bash may be denied/, 'Bash on slate paths is denied, not maybe');
  for (const name of ['link', 'done']) {
    const skill = await fs.readFile(`${PLUGIN}skills/${name}/SKILL.md`, 'utf8');
    const front = skill.split('\n---')[0];
    assert.match(front, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(front, /^description: .+/m);
    assert.match(front, /^disable-model-invocation: true$/m);
    assert.match(front, /^allowed-tools: Bash\(node:\*\)$/m);
    assert.ok(skill.includes('!`node "${CLAUDE_PLUGIN_ROOT}/scripts/slate.mjs" list "${CLAUDE_SESSION_ID}"`'), name);
    assert.ok(skill.includes('AskUserQuestion'), name);
  }
  // Live acceptance (2.1.308): after `linked`, the model restated the injected rules as bullets.
  const link = await fs.readFile(`${PLUGIN}skills/link/SKILL.md`, 'utf8');
  assert.match(link, /reply with one line saying so, and nothing else: don't restate the rules/);
  assert.equal(await exists(`${PLUGIN}skills/init`), false, 'the init skill is gone');
  assert.equal(await exists(`${PLUGIN}scripts/init.mjs`), false);
  assert.match(agent, /transcript[^\n]*Read with offset and limit/i, 'a transcript can exceed Read\'s limit');
  assert.doesNotMatch(agent, /with the Grep tool/i, '2.1.308 has no Grep tool');
});
