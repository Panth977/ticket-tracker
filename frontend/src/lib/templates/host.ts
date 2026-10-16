/**
 * THE PAGE'S SIDE OF A TEMPLATE (docs/plan/templates.html §B) — starts the
 * worker, sends it events, asks it to submit or to draw cards, and answers its
 * `api` calls through a TemplateBridge (as the person looking, for one board).
 *
 *   const w = new TemplateWorker({ code, kind: 'message', ctx, bridge, onRender });
 *   await w.ready;                 // compiled, state made, first tree drawn
 *   w.event(ref.$h, [value]);      // from the renderer
 *   const r = await w.submit();    // { result } | { error, line }
 *   w.destroy();
 *
 * THE SANDBOX: the worker starts from a data: URL, so its origin is opaque —
 * no cookies, no IndexedDB, no app storage, no same-origin requests to the
 * app's API. A WATCHDOG pings it every second; three seconds without an answer
 * (an endless loop) and it is terminated, with an error the editor can show.
 */
import type { TemplateKind } from '@tm/shared';
import runtimeSource from './worker/runtime.js?raw';
import type { FromWorker, ToWorker, VSlot } from './protocol';

/** Everything `api.*` in a template reaches. Each call is the viewer's own read of THIS board. */
export interface TemplateBridge {
  board(): Promise<unknown>;
  me(): Promise<unknown>;
  members(): Promise<unknown>;
  ticketGet(key: string): Promise<unknown>;
  ticketList(q: Record<string, unknown>): Promise<unknown>;
  ticketSearch(text: string, opts: Record<string, unknown>): Promise<unknown>;
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<unknown>;
}

export interface TemplateProblem {
  phase: string;
  message: string;
  line?: number;
}
export interface TemplateLog {
  level: 'log' | 'warn' | 'error';
  text: string;
  at: number;
}

export interface WorkerOptions {
  code: string;
  kind: TemplateKind;
  /** The template's ctx (board, me, ticket …) — plain data. */
  ctx: unknown;
  bridge: TemplateBridge;
  onRender?: (tree: VSlot[] | null, ack: number) => void;
  onError?: (e: TemplateProblem) => void;
  onLog?: (l: TemplateLog) => void;
  /** Test hook: build the Worker (default: a module worker from a data: URL). */
  spawn?: () => Worker;
}

const PING_MS = 1000;
/** Plain JSON data: what crosses to the worker (Svelte state proxies cannot be cloned). */
const plain = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const DEAD_MS = 3000;

/** The data: URL the worker starts from (opaque origin). */
export const runtimeUrl = (): string =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(runtimeSource)}`;

export class TemplateWorker {
  readonly ready: Promise<void>;
  private w: Worker;
  private seq = 0;
  private nextId = 1;
  private waits = new Map<number, (m: FromWorker) => void>();
  private timer: ReturnType<typeof setInterval>;
  private lastPong = Date.now();
  private pingN = 0;
  private dead = false;
  private settle!: { resolve: () => void; reject: (e: TemplateProblem) => void };

  constructor(private o: WorkerOptions) {
    this.ready = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    // Nobody may be awaiting `ready` (a card host waits on its own); never an unhandled rejection.
    this.ready.catch(() => {});
    this.w = o.spawn ? o.spawn() : new Worker(runtimeUrl(), { type: 'module', name: 'template' });
    this.w.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    this.w.onerror = (e) => {
      e.preventDefault?.();
      this.problem({
        phase: 'worker',
        message: e.message || 'The template worker failed to start',
      });
    };
    this.timer = setInterval(() => this.watch(), PING_MS);
  }

  private post(m: ToWorker) {
    if (!this.dead) this.w.postMessage(m);
  }

  private problem(p: TemplateProblem) {
    this.o.onError?.(p);
    this.settle.reject(p);
  }

  private watch() {
    if (this.dead) return;
    if (Date.now() - this.lastPong > DEAD_MS) {
      this.kill({
        phase: 'timeout',
        message: 'The template stopped responding (an endless loop?) and was stopped.',
      });
      return;
    }
    this.post({ type: 'ping', n: ++this.pingN });
  }

  private kill(p: TemplateProblem) {
    this.destroy();
    this.problem(p);
    for (const [, wake] of this.waits) wake({ type: 'error', ...p });
    this.waits.clear();
  }

  private async receive(m: FromWorker) {
    this.lastPong = Date.now();
    switch (m.type) {
      case 'ready':
        this.post({ type: 'load', code: this.o.code, kind: this.o.kind, ctx: plain(this.o.ctx) });
        return;
      case 'loaded':
        this.settle.resolve();
        return;
      case 'render':
        this.o.onRender?.(m.tree, m.ack);
        return;
      case 'error':
        this.problem({ phase: m.phase, message: m.message, line: m.line });
        return;
      case 'log':
        this.o.onLog?.({ level: m.level, text: m.text, at: Date.now() });
        return;
      case 'submitted':
      case 'cards': {
        const wake = this.waits.get(m.id);
        this.waits.delete(m.id);
        wake?.(m);
        return;
      }
      case 'api': {
        try {
          const value = await this.callBridge(m.method, m.args);
          this.post({ type: 'apiResult', id: m.id, ok: true, value: plain(value) });
        } catch (e) {
          this.post({
            type: 'apiResult',
            id: m.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      case 'pong':
        return;
    }
  }

  /** The whitelist: a method not named here does not exist for a template. */
  private callBridge(method: string, args: unknown[]): Promise<unknown> {
    const b = this.o.bridge;
    const s = (i: number) => (typeof args[i] === 'string' ? (args[i] as string) : '');
    const o = (i: number) =>
      args[i] && typeof args[i] === 'object' ? (args[i] as Record<string, unknown>) : {};
    switch (method) {
      case 'board':
        return b.board();
      case 'me':
        return b.me();
      case 'members':
        return b.members();
      case 'tickets.get':
        return b.ticketGet(s(0));
      case 'tickets.list':
        return b.ticketList(o(0));
      case 'tickets.search':
        return b.ticketSearch(s(0), o(1));
      case 'storage.get':
        return b.storageGet(s(0));
      case 'storage.set':
        return b.storageSet(s(0), args[1]);
      default:
        return Promise.reject(new Error(`api.${method} does not exist`));
    }
  }

  /** An input / click from the renderer; answers its sequence number. */
  event(h: string, args: unknown[]): number {
    const seq = ++this.seq;
    this.post({ type: 'event', seq, h, args: plain(args) });
    return seq;
  }

  private ask<T extends FromWorker>(m: ToWorker & { id: number }): Promise<T> {
    return new Promise((resolve) => {
      this.waits.set(m.id, resolve as (m: FromWorker) => void);
      this.post(m);
    });
  }

  /** Run the template's submit(state, ctx). */
  async submit(): Promise<{ result?: unknown; error?: string; line?: number }> {
    if (this.dead) return { error: 'The template was stopped' };
    const r = await this.ask<FromWorker>({ type: 'submit', id: this.nextId++ });
    if (r.type === 'submitted') return { result: r.result, error: r.error, line: r.line };
    if (r.type === 'error') return { error: r.message };
    return { error: 'The template did not answer' };
  }

  /** Draw cards: one tree per item. */
  async cards(
    items: { id: string; ctx: unknown }[],
  ): Promise<{ id: string; tree?: VSlot[]; error?: string; line?: number }[]> {
    if (this.dead) return items.map((i) => ({ id: i.id, error: 'The template was stopped' }));
    const r = await this.ask<FromWorker>({ type: 'cards', id: this.nextId++, items: plain(items) });
    if (r.type === 'cards') return r.results;
    const message = r.type === 'error' ? r.message : 'The template did not answer';
    return items.map((i) => ({ id: i.id, error: message }));
  }

  get stopped() {
    return this.dead;
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.timer);
    this.w.terminate();
  }
}
