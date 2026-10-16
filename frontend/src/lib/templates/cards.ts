/**
 * CARD TEMPLATES ON A BOARD (docs/plan/templates.html §E) — ONE worker per
 * card template, shared by every card that uses it. Cards ask for their tree;
 * the asks of one tick go to the worker as one batch; a tree is kept per
 * ticket until the ticket changes (its updatedAt), so scrolling, re-grouping
 * and live updates of OTHER tickets cost nothing.
 *
 *   const host = acquireCardHost(template, board, me);
 *   const tree = await host.tree(ticket);   // VSlot[] | throws the template's error
 *   releaseCardHost(host);
 */
import type { Board, Ticket, TemplateWithId } from '@tm/shared';
import { contextFor, createBridge } from './bridge';
import { TemplateWorker, type TemplateProblem } from './host';
import type { VSlot } from './protocol';

type Result = { tree?: VSlot[]; error?: string; line?: number };

export class CardHost {
  private worker: TemplateWorker | null = null;
  private start: Promise<TemplateWorker>;
  private cache = new Map<string, { stamp: number; result: Promise<Result> }>();
  private batch: { id: string; ticket: Ticket & { id: string }; done: (r: Result) => void }[] = [];
  private scheduled = false;
  private bridge: ReturnType<typeof createBridge>;
  problem: TemplateProblem | null = null;
  refs = 0;

  constructor(
    readonly template: TemplateWithId,
    board: Board & { id: string },
    me: { id: string; name: string; email: string; role: string },
  ) {
    this.bridge = createBridge({ board, me, templateId: template.id });
    this.start = contextFor(this.bridge, { kind: 'card' }).then((ctx) => {
      const w = new TemplateWorker({
        code: template.code,
        kind: 'card',
        ctx,
        bridge: this.bridge,
        onError: (p) => (this.problem = p),
      });
      this.worker = w;
      return w.ready.then(() => w);
    });
    this.start.catch(() => {});
  }

  /** The card's tree; a template error rejects with its message. */
  tree(ticket: Ticket & { id: string }): Promise<Result> {
    const hit = this.cache.get(ticket.id);
    if (hit && hit.stamp === ticket.updatedAt) return hit.result;
    const result = new Promise<Result>((done) => {
      this.batch.push({ id: ticket.id, ticket, done });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
    this.cache.set(ticket.id, { stamp: ticket.updatedAt, result });
    return result;
  }

  private async flush() {
    this.scheduled = false;
    const items = this.batch.splice(0);
    if (!items.length) return;
    let w: TemplateWorker;
    try {
      w = await this.start;
    } catch (e) {
      const p = (e as TemplateProblem) ?? this.problem;
      for (const i of items)
        i.done({ error: p?.message ?? 'The card template did not load', line: p?.line });
      return;
    }
    const withCtx = await Promise.all(
      items.map(async (i) => ({ id: i.id, ctx: { ticket: await this.bridge.infoOf(i.ticket) } })),
    );
    const results = await w.cards(withCtx);
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const i of items) i.done(byId.get(i.id) ?? { error: 'No answer for this card' });
  }

  destroy() {
    this.worker?.destroy();
    this.cache.clear();
  }
}

const hosts = new Map<string, CardHost>();
const keyOf = (t: TemplateWithId, boardId: string) => `${boardId}:${t.id}:${t.updatedAt}`;

export function acquireCardHost(
  template: TemplateWithId,
  board: Board & { id: string },
  me: { id: string; name: string; email: string; role: string },
): CardHost {
  const key = keyOf(template, board.id);
  let h = hosts.get(key);
  if (!h) {
    h = new CardHost(template, board, me);
    hosts.set(key, h);
  }
  h.refs += 1;
  return h;
}

export function releaseCardHost(h: CardHost, boardId: string) {
  h.refs -= 1;
  // A re-render releases and re-acquires at once: keep the worker a moment.
  setTimeout(() => {
    if (h.refs > 0) return;
    const key = keyOf(h.template, boardId);
    if (hosts.get(key) === h) hosts.delete(key);
    h.destroy();
  }, 2000);
}
