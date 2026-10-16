/** The worker runtime (templates.html §B, §C), run against a fake worker scope. */
import { describe, expect, it } from 'vitest';
import { TEMPLATE_STARTERS } from '@tm/shared';
import { boot } from './worker/runtime.js';
import type { FromWorker, ToWorker, VElement, VSlot } from './protocol';

function fakeWorker() {
  const out: FromWorker[] = [];
  const scope: {
    postMessage: (m: FromWorker) => void;
    onmessage?: (e: { data: ToWorker }) => void;
    console: Console;
  } = {
    postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))),
    console: { ...console, log: () => {}, warn: () => {}, error: () => {} } as Console,
  };
  boot(scope);
  const send = (m: ToWorker) => scope.onmessage!({ data: m });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const last = <T extends FromWorker['type']>(type: T) =>
    [...out].reverse().find((m) => m.type === type) as Extract<FromWorker, { type: T }> | undefined;
  return { out, send, tick, last };
}

const find = (tree: VSlot[] | null | undefined, t: string): VElement | undefined => {
  for (const n of tree ?? []) {
    if (!n || typeof n === 'string') continue;
    if (n.t === t) return n;
    const hit = find(n.c, t);
    if (hit) return hit;
  }
  return undefined;
};

describe('template runtime', () => {
  it('loads the message starter, renders, handles events and submits', async () => {
    const w = fakeWorker();
    expect(w.out[0]).toEqual({ type: 'ready' });
    w.send({
      type: 'load',
      code: TEMPLATE_STARTERS.message,
      kind: 'message',
      ctx: { kind: 'message' },
    });
    await w.tick();
    expect(w.last('loaded')).toBeTruthy();
    const first = w.last('render')!;
    expect(first.ack).toBe(0);
    const ta = find(first.tree, 'textarea')!;
    expect(ta.p.label).toBe('Steps to reproduce');
    const onInput = ta.p.onInput as { $h: string };
    expect(onInput.$h).toMatch(/textarea\|onInput$/);

    // Empty submit: invalid, with a field error.
    w.send({ type: 'submit', id: 1 });
    await w.tick();
    expect(w.last('submitted')).toMatchObject({
      id: 1,
      result: { type: 'invalid', error: { steps: 'Required' } },
    });

    w.send({ type: 'event', seq: 1, h: onInput.$h, args: ['It crashes'] });
    await w.tick();
    const second = w.last('render')!;
    expect(second.ack).toBe(1);
    expect(find(second.tree, 'textarea')!.p.value).toBe('It crashes');

    w.send({ type: 'submit', id: 2 });
    await w.tick();
    expect(w.last('submitted')).toMatchObject({
      id: 2,
      result: { type: 'valid', msg: '**Bug** · severity medium\n\nIt crashes' },
    });
  });

  it('an event still runs after many renders went by (typing fast never drops a key)', async () => {
    const w = fakeWorker();
    const code = `export default {
      state: { v: '' },
      render: (s, set, h) => h.col(h.text(s.v), h.input({ value: s.v, onInput: (v) => set({ v }) })),
      submit: (s) => ({ type: 'valid', msg: s.v }),
    }`;
    w.send({ type: 'load', code, kind: 'message', ctx: {} });
    await w.tick();
    // The page still holds the FIRST tree's handler id while ten keys go out.
    const ref = (find(w.last('render')!.tree, 'input')!.p.onInput as { $h: string }).$h;
    let typed = '';
    for (let i = 1; i <= 10; i++) {
      typed += String(i % 10);
      w.send({ type: 'event', seq: i, h: ref, args: [typed] });
      await w.tick();
    }
    const r = w.last('render')!;
    expect(r.ack).toBe(10);
    expect(find(r.tree, 'input')!.p.value).toBe(typed);
  });

  it('keeps holes, so a conditional field never shifts the ones after it', async () => {
    const w = fakeWorker();
    const code = `export default {
      state: { on: false },
      render: (s, set, h) => h.col(s.on && h.text('extra'), h.input({ value: 'x' })),
      submit: () => ({ type: 'valid', msg: 'x' }),
    }`;
    w.send({ type: 'load', code, kind: 'message', ctx: {} });
    await w.tick();
    const col = w.last('render')!.tree![0] as VElement;
    expect(col.c).toHaveLength(2);
    expect(col.c![0]).toBeNull();
    expect((col.c![1] as VElement).t).toBe('input');
  });

  it('reports compile and render errors with the template line', async () => {
    const w = fakeWorker();
    w.send({ type: 'load', code: 'const x = 1;', kind: 'card', ctx: {} });
    await w.tick();
    expect(w.last('error')).toMatchObject({ phase: 'compile' });

    const w2 = fakeWorker();
    const code = `export default {
  render(s, set, h) {
    return h.text(undefinedThing);
  },
  submit: () => ({ type: 'valid', msg: 'x' }),
};`;
    w2.send({ type: 'load', code, kind: 'message', ctx: {} });
    await w2.tick();
    const err = w2.last('error')!;
    expect(err.phase).toBe('render');
    expect(err.message).toMatch(/undefinedThing/);
    expect(err.line).toBe(3);
  });

  it('a message template must have submit; a card template need not', async () => {
    const w = fakeWorker();
    w.send({
      type: 'load',
      code: 'export default { render: (s, set, h) => h.text("x") }',
      kind: 'message',
      ctx: {},
    });
    await w.tick();
    expect(w.last('error')!.message).toMatch(/submit/);
  });

  it('draws cards, one tree per ticket, without handlers', async () => {
    const w = fakeWorker();
    w.send({ type: 'load', code: TEMPLATE_STARTERS.card, kind: 'card', ctx: { kind: 'card' } });
    await w.tick();
    const ticket = (key: string) => ({
      key,
      title: `T ${key}`,
      priority: { name: 'High', color: '#f00' },
      assignees: [{ id: 'u1' }],
    });
    w.send({
      type: 'cards',
      id: 7,
      items: [
        { id: 'a', ctx: { ticket: ticket('ENG-1') } },
        { id: 'b', ctx: { ticket: { key: 'ENG-2' } } },
      ],
    });
    await w.tick();
    await w.tick();
    const r = w.last('cards')!;
    expect(r.id).toBe(7);
    expect(r.results[0]!.id).toBe('a');
    expect(JSON.stringify(r.results[0]!.tree)).toContain('T ENG-1');
    expect(JSON.stringify(r.results[0]!.tree)).not.toContain('$h');
    // The second card's template threw (no assignees) — only that card fails.
    expect(r.results[1]!.error).toBeTruthy();
  });

  it('api calls go to the page and come back', async () => {
    const w = fakeWorker();
    const code = `export default {
      state: async () => ({ board: await api.board() }),
      render: (s, set, h) => h.text(s.board.name),
      submit: () => ({ type: 'valid', msg: 'x' }),
    }`;
    w.send({ type: 'load', code, kind: 'message', ctx: {} });
    await w.tick();
    const call = w.last('api')!;
    expect(call.method).toBe('board');
    w.send({ type: 'apiResult', id: call.id, ok: true, value: { name: 'Engineering' } });
    await w.tick();
    expect(JSON.stringify(w.last('render')!.tree)).toContain('Engineering');
  });

  it('h.el refuses tags outside the list; logs reach the page; ping answers', async () => {
    const w = fakeWorker();
    const code = `export default {
      render: (s, set, h) => { console.log('hi', { a: 1 }); return h.el('script', 'x'); },
      submit: () => ({ type: 'valid', msg: 'x' }),
    }`;
    w.send({ type: 'load', code, kind: 'message', ctx: {} });
    await w.tick();
    expect(w.last('log')).toMatchObject({ level: 'log', text: 'hi {"a":1}' });
    expect(w.last('error')!.message).toMatch(/<script> is not allowed/);
    w.send({ type: 'ping', n: 3 });
    await w.tick();
    expect(w.last('pong')).toEqual({ type: 'pong', n: 3 });
  });
});
