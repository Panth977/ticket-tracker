/** The board script in the worker runtime (board-script.html), against a fake worker scope. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOARD_SCRIPT,
  generateBoardScript,
  ScriptControlsSchema,
  ScriptPatchSchema,
} from '@tm/shared';
import { boot } from './worker/runtime.js';
import type { FromWorker, ToWorker } from './protocol';

function fakeWorker() {
  const out: FromWorker[] = [];
  const scope: {
    postMessage: (m: FromWorker) => void;
    onmessage?: (e: { data: ToWorker }) => void;
  } = {
    postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))),
  };
  boot(scope);
  const send = (m: ToWorker) => scope.onmessage!({ data: m });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let id = 0;
  const call = async (op: string, args: unknown) => {
    const n = ++id;
    send({ type: 'script', id: n, op: op as never, args });
    for (let i = 0; i < 20; i++) {
      await tick();
      const hit = out.find((m) => m.type === 'scripted' && m.id === n);
      if (hit) return hit as Extract<FromWorker, { type: 'scripted' }>;
    }
    throw new Error(`no answer to ${op}`);
  };
  const load = async (code: string) => {
    send({
      type: 'load',
      code,
      kind: 'script',
      ctx: { me: { id: 'u1', name: 'Ada', email: 'ada@x.test', role: 'editor' }, board: BOARD },
    });
    await tick();
  };
  return { out, send, call, load };
}

const BOARD = {
  id: 'b1',
  key: 'ENG',
  name: 'Engineering',
  stages: [],
  priorities: [{ id: 'p1', name: 'High', color: '#f00' }],
  tags: [{ id: 't1', name: 'bug', color: null }],
  fields: [
    {
      id: 'f_client',
      name: 'Client',
      type: 'select',
      required: false,
      options: [{ id: 'o1', name: 'Acme', color: null }],
    },
  ],
};
const ticket = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  key: `ENG-${id}`,
  title: `T ${id}`,
  assigneeUids: [],
  priorityId: null,
  tagIds: [],
  startAt: null,
  dueAt: null,
  dueAllDay: true,
  estimate: null,
  fields: {},
  ...over,
});

describe('board script runtime', () => {
  it('runs the default script: Assignees, "Only mine", the patch', async () => {
    const w = fakeWorker();
    await w.load(DEFAULT_BOARD_SCRIPT);
    expect(w.out.find((m) => m.type === 'loaded')).toBeTruthy();

    const defaults = await w.call('filters', {});
    expect(defaults.value).toEqual({ mine: false, assignee: [] });

    const fields = await w.call('fieldRender', { ticket: ticket('1', { assigneeUids: ['u2'] }) });
    const controls = ScriptControlsSchema.parse(fields.value);
    expect(controls).toEqual([
      { type: 'people', id: 'assignees', label: 'Assignees', value: ['u2'], commitments: true },
    ]);

    const change = await w.call('change', { ticket: ticket('1'), id: 'assignees', value: ['u1'] });
    expect(ScriptPatchSchema.parse(change.value)).toEqual({ assigneeUids: ['u1'] });

    const mine = await w.call('apply', {
      tickets: [ticket('1', { assigneeUids: ['u1'] }), ticket('2', { assigneeUids: ['u2'] })],
      filters: { mine: true, assignee: [] },
    });
    expect(mine.value).toEqual({ keep: ['1'], order: null });
    const all = await w.call('apply', {
      tickets: [ticket('1'), ticket('2')],
      filters: { mine: false, assignee: [] },
    });
    expect(all.value).toEqual({ keep: ['1', '2'], order: null });
  });

  it('a generated script draws the old fields and writes the old columns', async () => {
    const code = generateBoardScript({
      priorities: [{ id: 'p1', name: 'High', color: '#f00' }],
      tags: [{ id: 't1', name: "it's a bug" }],
      fields: [
        { id: 'f_client', name: 'Client', type: 'select', options: [{ id: 'o1', name: 'Acme' }] },
        { id: 'f_formula', name: 'Total', type: 'formula' },
      ],
    });
    expect(code).toContain('Not drawn (no control for the type): Total (formula).');
    // The option lists are code (no Priorities / Tags settings pages any more).
    expect(code).toContain(
      "const PRIORITIES = [\n  { value: 'p1', label: 'High', color: '#f00' },\n];",
    );
    expect(code).toContain("{ value: 't1', label: 'it\\'s a bug' }");
    expect(code).toContain("const CLIENT = [\n  { value: 'o1', label: 'Acme' },\n];");
    const w = fakeWorker();
    await w.load(code);
    const fields = await w.call('fieldRender', {
      ticket: ticket('1', { priorityId: 'p1', fields: { f_client: 'o1' } }),
    });
    const controls = ScriptControlsSchema.parse(fields.value);
    expect(controls.map((c) => c.id)).toEqual([
      'priority',
      'assignees',
      'start',
      'due',
      'estimate',
      'tags',
      'f_client',
    ]);
    expect(controls.find((c) => c.id === 'f_client')).toMatchObject({
      type: 'select',
      value: 'o1',
      options: [{ value: 'o1', label: 'Acme' }],
    });
    expect(
      (await w.call('change', { ticket: ticket('1'), id: 'due', value: 5, allDay: false })).value,
    ).toEqual({
      dueAt: 5,
      dueAllDay: false,
    });
    expect(
      (await w.call('change', { ticket: ticket('1'), id: 'f_client', value: 'o1' })).value,
    ).toEqual({
      fields: { f_client: 'o1' },
    });
    const kept = await w.call('apply', {
      tickets: [ticket('1', { priorityId: 'p1' }), ticket('2')],
      filters: { mine: false, assignee: [], priority: 'p1', tags: [] },
    });
    expect(kept.value).toEqual({ keep: ['1'], order: null });
  });

  it('class or object, this.api, onSort, and named arguments everywhere', async () => {
    const w = fakeWorker();
    await w.load(`export default {
      fieldRender({ ticket }) { return [ui.text({ id: 'note', label: 'Note', value: ticket.fields.note ?? '' })]; },
      onFieldChange({ id, value }) { return { fields: { [id]: value } }; },
      onSort({ a, b }) { return b.title.localeCompare(a.title); },
    }`);
    const sorted = await w.call('apply', { tickets: [ticket('1'), ticket('2')], filters: {} });
    expect(sorted.value).toEqual({ keep: ['1', '2'], order: ['2', '1'] });

    const bad = fakeWorker();
    await bad.load(`export default class S { fieldRender() { return [ui.text('note')]; } }`);
    const r = await bad.call('fieldRender', { ticket: ticket('1') });
    expect(r.error).toMatch(/ui\.text takes one object of named arguments/);

    const api = fakeWorker();
    await api.load(`export default class S {
      async fieldRender() { const t = await this.api.tickets.get({ key: 'ENG-9' }); return [ui.note({ text: t.title })]; }
    }`);
    const pending = api.call('fieldRender', { ticket: ticket('1') });
    await new Promise((r) => setTimeout(r, 0));
    const req = api.out.find((m) => m.type === 'api') as Extract<FromWorker, { type: 'api' }>;
    expect(req).toMatchObject({ method: 'tickets.get', args: ['ENG-9'] });
    api.send({ type: 'apiResult', id: req.id, ok: true, value: { title: 'Nine' } });
    expect((await pending).value).toEqual([{ type: 'note', text: 'Nine' }]);
  });

  it('a script without fieldRender does not load', async () => {
    const w = fakeWorker();
    await w.load(`export default class S {}`);
    const err = w.out.find((m) => m.type === 'error') as Extract<FromWorker, { type: 'error' }>;
    expect(err.message).toMatch(/fieldRender/);
  });
});
