// Run by `claude plugin test plugins/slate`, against the engine's own harness (test/status.test.mjs starts it).
import { expect, mock, test } from 'claude-code/testing';

const BAND = {
  plugin: 'slate',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const SLATES = ['slate-plugin', 'old-jet', 'jetpack-seo', 'jetpack-forms'];

// Stands for Claude Code. `state` is what `slate.mjs list` reports for a session; `ran` collects commands.
function engine(
  on: any,
  { state = 'unlinked', fail = false, slates = SLATES, answer = 'jetpack-seo' as string | null, surfaces = ['terminal'] } = {},
) {
  const t = { state, ran: [] as any[], argv: [] as string[], asks: [] as any[] };
  on('classic.SessionStart', () => ({}));
  on('turn.complete', () => ({ text: '' }));
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }));
  on('session.id', () => ({ value: 's1' }));
  on('session.surfaces', () => ({ value: surfaces }));
  on('process.run', (_: unknown, e: any) => {
    if (fail) throw new Error('nope');
    t.argv = e.argv;
    const stdout = e.argv[2] === 'digest'
      ? 'digest\nproject: x\n\n## jetpack-seo\nF1 seo work\n'
      : [t.state, ...slates, 'project: x', 'branch: y', ''].join('\n');
    return { value: { exitCode: 0, stdout, stderr: '' } };
  });
  on('model.complete', (_: unknown, e: any) => {
    t.asks.push(e);
    return {
      value: answer === null ? { isAnswered: false, reason: 'api-error', usage: {} } : { isAnswered: true, text: answer, usage: {} },
    };
  });
  on('command.run', (_: unknown, e: any) => {
    t.ran.push([e.command, e.args]);
    return { value: { text: '' } };
  });
  return t;
}

const start = ($: any) => $.classic.SessionStart({ source: 'startup', session_id: 's1' });
const mount = ($: any, props = {}) => $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } });
const words = async (ui: any, text: RegExp) => (await ui.find({ type: 'Text', text }))?.text;
const button = (ui: any, key: string) => ui.find({ type: 'Button', key });

test('a linked session shows its slate and no field', async ($, on) => {
  engine(on, { state: 'linked alpha' });
  await start($);
  const ui = await mount($);
  expect(await words(ui, /alpha/)).toBe(' alpha');
  expect(await words(ui, /not linked/)).toBeFalsy();
  expect(await ui.find({ type: 'Input' })).toBeFalsy();
  await ui.unmount();
});

test('a session on no slate says so and offers the field', async ($, on) => {
  engine(on);
  await start($);
  const ui = await mount($);
  expect(await words(ui, /not linked/)).toBe(' not linked  ');
  expect(await ui.find({ type: 'Input', key: 'slate-link' })).toBeTruthy();
  await ui.unmount();
});

test('asks the plugin script about this session', async ($, on) => {
  const t = engine(on);
  await start($);
  expect(t.argv.slice(0, 1)).toEqual(['node']);
  expect(t.argv[1]).toMatch(/\/scripts\/slate\.mjs$/);
  expect(t.argv.slice(2)).toEqual(['list', 's1']);
});

test('nothing is drawn until the first lookup finishes', async ($, on) => {
  engine(on);
  const ui = await mount($);
  expect(await words(ui, /slate|not linked/i)).toBeFalsy();
  await ui.unmount();
});

test('a failed lookup leaves startup alone', async ($, on) => {
  engine(on, { fail: true });
  await start($);
  const ui = await mount($);
  expect(await words(ui, /not linked/)).toBe(' not linked  ');
  await ui.unmount();
});

test('no suggestions before typing', async ($, on) => {
  engine(on);
  await start($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Button' })).toBeFalsy();
  await ui.unmount();
});

test('typing filters the slates, names starting with it first', async ($, on) => {
  engine(on);
  await start($);
  const ui = await mount($);
  await ui.input({ key: 'slate-link', text: 'jet', kind: 'change' });
  const found = await ui.findAll({ type: 'Button' });
  expect(found.map((b: any) => b.key)).toEqual(['jetpack-seo', 'jetpack-forms', 'old-jet']);
  expect(await button(ui, 'slate-plugin')).toBeFalsy();
  await ui.unmount();
});

test('a name with no match says enter creates it', async ($, on) => {
  engine(on);
  await start($);
  const ui = await mount($);
  await ui.input({ key: 'slate-link', text: 'zzz', kind: 'change' });
  expect(await ui.find({ type: 'Button' })).toBeFalsy();
  expect(await words(ui, /no match/)).toBe('no match · enter to create');
  await ui.unmount();
});

test('enter links exactly what was typed', async ($, on) => {
  const t = engine(on);
  await start($);
  const ui = await mount($);
  await ui.input({ key: 'slate-link', text: ' jet ', kind: 'submit' });
  expect(t.ran).toEqual([['slate:link', 'jet']]);
  await ui.unmount();
});

test('enter on an empty field does nothing', async ($, on) => {
  const t = engine(on);
  await start($);
  const ui = await mount($);
  await ui.input({ key: 'slate-link', text: '  ', kind: 'submit' });
  expect(t.ran).toEqual([]);
  await ui.unmount();
});

test('pressing a suggestion links it', async ($, on) => {
  const t = engine(on);
  await start($);
  const ui = await mount($);
  await ui.input({ key: 'slate-link', text: 'seo', kind: 'change' });
  await ui.press({ key: 'jetpack-seo' });
  expect(t.ran).toEqual([['slate:link', 'jetpack-seo']]);
  await ui.unmount();
});

test('the end of a turn swaps the field for the linked slate and forgets the typing', async ($, on) => {
  const t = engine(on);
  await start($);
  const ui = await mount($);
  await ui.input({ key: 'slate-link', text: 'jet', kind: 'change' });
  t.state = 'linked jetpack-seo';
  await ($ as any).turn.complete({ answer: '', reason: 'answer' });
  expect(await words(ui, /jetpack-seo/)).toBe(' jetpack-seo');
  expect(await ui.find({ type: 'Input' })).toBeFalsy();

  t.state = 'unlinked';
  await ($ as any).turn.complete({ answer: '', reason: 'answer' });
  expect(await ui.find({ type: 'Button' })).toBeFalsy();
  await ui.unmount();
});

test('a band from another plugin stays', async ($, on) => {
  engine(on);
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e);
    return <Text>other band</Text>;
  });
  await start($);
  const ui = await mount($);
  expect(await words(ui, /other band/)).toBe('other band');
  expect(await words(ui, /not linked/)).toBe(' not linked  ');
  await ui.unmount();
});

test('a survey has the band to itself', async ($, on) => {
  engine(on);
  await start($);
  const ui = await mount($, { hasSurvey: true });
  expect(await words(ui, /slate|not linked/i)).toBeFalsy();
  expect(await ui.find({ type: 'Input' })).toBeFalsy();
  await ui.unmount();
});

// --- the suggestion after two prompts ---

const typed = ($: any, text: string, extra = {}) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...extra });
const finishTurn = ($: any, extra = {}) =>
  $.turn.complete({ answer: '', reason: 'answer', isAborted: false, durationMs: 0, turnId: 't', ...extra });

async function turn($: any, clock: any, text: string, extra = {}) {
  await typed($, text, extra);
  await finishTurn($);
  await clock.advance(1);
}

test('after two typed prompts it suggests the slate the model names', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'fix the sitemap');
  await turn($, clock, 'and the robots file');

  expect(t.asks.length).toBe(1);
  expect(t.asks[0].model).toBe('haiku');
  expect(t.asks[0].prompt).toContain('fix the sitemap');
  expect(t.asks[0].prompt).toContain('and the robots file');
  expect(t.asks[0].prompt).toContain('F1 seo work');
  expect(t.asks[0].prompt).not.toContain('digest\n');

  const ui = await mount($);
  expect(await words(ui, /Looks like/)).toBe('Looks like ');
  expect(await words(ui, /jetpack-seo/)).toBe('jetpack-seo');
  expect(await button(ui, 'slate-suggest-link')).toBeTruthy();
  expect(await button(ui, 'slate-suggest-dismiss')).toBeTruthy();
  expect(t.ran).toEqual([]);
  await ui.unmount();
});

test('one prompt is not enough', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'fix the sitemap');
  expect(t.asks.length).toBe(0);
});

test('slash commands, hidden prompts and other sources do not count', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'real one');
  await turn($, clock, '/compact', { command: { name: 'compact' } });
  await turn($, clock, 'hidden', { isMeta: true });
  await turn($, clock, 'done', { origin: { kind: 'task-notification' } });
  expect(t.asks.length).toBe(0);
});

test('it asks only once per session', async ($, on) => {
  const t = engine(on, { answer: 'NONE' });
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  await turn($, clock, 'three');
  expect(t.asks.length).toBe(1);
});

for (const [why, answer] of [['NONE', 'NONE'], ['a name not on the list', 'made-up'], ['a failed call', null]] as const) {
  test(`${why} leaves the row as it was`, async ($, on) => {
    engine(on, { answer });
    const clock = mock.clock(on);
    await start($);
    await turn($, clock, 'one');
    await turn($, clock, 'two');
    const ui = await mount($);
    expect(await words(ui, /Looks like/)).toBeFalsy();
    expect(await ui.find({ type: 'Button' })).toBeFalsy();
    await ui.unmount();
  });
}

test('no slates means no model call', async ($, on) => {
  const t = engine(on, { slates: [] });
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  expect(t.asks.length).toBe(0);
});

test('a linked session makes no model call', async ($, on) => {
  const t = engine(on, { state: 'linked alpha' });
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  expect(t.asks.length).toBe(0);
});

test('a headless session makes no model call', async ($, on) => {
  const t = engine(on, { surfaces: [] });
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  expect(t.asks.length).toBe(0);
});

test('an interrupted turn does not trigger it', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await typed($, 'two');
  await finishTurn($, { isAborted: true, reason: 'aborted' });
  await clock.advance(1);
  expect(t.asks.length).toBe(0);
});

test('Link runs /slate:link for the suggested slate', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  const ui = await mount($);
  await ui.press({ key: 'slate-suggest-link' });
  expect(t.ran).toEqual([['slate:link', 'jetpack-seo']]);
  await ui.unmount();
});

test('Not now hides it and it does not come back', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  const ui = await mount($);
  await ui.press({ key: 'slate-suggest-dismiss' });
  expect(await words(ui, /Looks like/)).toBeFalsy();
  await turn($, clock, 'three');
  expect(await words(ui, /Looks like/)).toBeFalsy();
  expect(t.asks.length).toBe(1);
  expect(t.ran).toEqual([]);
  await ui.unmount();
});

test('linking clears the suggestion', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  const ui = await mount($);
  t.state = 'linked jetpack-seo';
  await finishTurn($);
  expect(await words(ui, /Looks like/)).toBeFalsy();
  await ui.unmount();
});

test('/clear starts the count again', async ($, on) => {
  const t = engine(on);
  const clock = mock.clock(on);
  await start($);
  await turn($, clock, 'one');
  await turn($, clock, 'two');
  await ($ as any).classic.SessionStart({ source: 'clear', session_id: 's1' });

  const ui = await mount($);
  expect(await words(ui, /Looks like/)).toBeFalsy();
  await ui.unmount();

  await turn($, clock, 'three');
  expect(t.asks.length).toBe(1);
  await turn($, clock, 'four');
  expect(t.asks.length).toBe(2);
  expect(t.asks[1].prompt).toContain('three');
  expect(t.asks[1].prompt).not.toContain('one');
});
