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

test('hooks.json wraps six events and every plugin-root path exists', async () => {
  const cfg = await json(`${PLUGIN}hooks/hooks.json`);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
  const cmds = Object.values(cfg.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.length, 6);
  for (const c of cmds) {
    for (const [, rel] of c.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
      assert.ok(await exists(PLUGIN + rel), rel);
    }
  }
});

test('skill and agent frontmatter', async () => {
  const skill = await fs.readFile(`${PLUGIN}skills/init/SKILL.md`, 'utf8');
  assert.match(skill, /^---\nname: init\n/);
  assert.match(skill, /description: .+/);
  assert.match(skill, /allowed-tools: Bash\(node:\*\)/);
  assert.match(skill.split('\n---')[0], /^disable-model-invocation: true$/m, 'only the user turns slate on');
  assert.ok(skill.includes('!`node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" "${CLAUDE_SESSION_ID}"`'));
  const agent = await fs.readFile(`${PLUGIN}agents/offload.md`, 'utf8');
  assert.match(agent, /^---\nname: offload\n/);
  assert.match(agent, /description: .+/);
  const description = /^description: (.+)$/m.exec(agent)[1];
  assert.match(description, /^slate sessions only\b.*\.slate\//i, 'other sessions should not pick the agent');
  assert.ok(description.length <= 250, `description is ${description.length} chars`);
  assert.doesNotMatch(description, /: /, 'a plain YAML scalar');
  assert.doesNotMatch(agent.split('\n---')[0], /^tools:/m);
  assert.match(agent, /hand-back tool.*600|600.*hand-back tool/i, 'the return limit also covers a hand-back message');
  assert.match(agent, /\.jsonl.*transcript|transcript.*\.jsonl/i, 'a past run is reachable through its transcript path');
});
