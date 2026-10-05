/**
 * Two windows that can postMessage each other — all of a browser the driver
 * needs. Delivery is asynchronous and the data is structured-cloned, as the
 * real thing does, so a test cannot pass by sharing an object reference.
 */
import type { WindowLike } from '../src/transport.js';

type Listener = (event: {
  data: unknown;
  source: unknown;
  origin: string;
  key?: string | null;
}) => void;

export class FakeWindow implements WindowLike {
  parent: FakeWindow = this;
  location = { search: '' };
  origin = 'null';
  /** Every message this window was sent, in order (after cloning). */
  received: unknown[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private store = new Map<string, string>();
  /** Set to make `localStorage` throw, as it does in a sandboxed iframe. */
  storageThrows = false;
  /** Who is calling postMessage on this window (the fake has no caller context). */
  private sender: FakeWindow | null = null;

  constructor(search = '') {
    this.location.search = search;
  }

  get localStorage() {
    if (this.storageThrows) throw new Error('SecurityError: sandboxed');
    return {
      getItem: (k: string) => this.store.get(k) ?? null,
      setItem: (k: string, v: string) => void this.store.set(k, v),
    };
  }

  addEventListener(type: string, listener: (event: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as Listener);
  }
  removeEventListener(type: string, listener: (event: never) => void) {
    this.listeners.get(type)?.delete(listener as Listener);
  }
  dispatch(type: string, event: Parameters<Listener>[0]) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }

  /** `from.send(to, msg)` is `to.postMessage(msg, '*')` called by `from`. */
  postMessage(data: unknown, _targetOrigin: string) {
    const source = this.sender ?? childOf.get(this) ?? this;
    const clone = structuredClone(data);
    this.received.push(clone);
    void Promise.resolve().then(() =>
      this.dispatch('message', { data: clone, source, origin: source.origin }),
    );
  }
  /** Post to this window AS `from` (event.source will be `from`). */
  postFrom(from: FakeWindow, data: unknown) {
    this.sender = from;
    try {
      this.postMessage(data, '*');
    } finally {
      this.sender = null;
    }
  }
}

// The driver calls parent.postMessage(...) with no way to say who it is; the
// fake resolves "the caller" as the frame registered for that parent.
const childOf = new WeakMap<FakeWindow, FakeWindow>();

/** A host page and the sandboxed frame inside it. */
export function framePair(search = ''): { host: FakeWindow; frame: FakeWindow } {
  const host = new FakeWindow();
  host.origin = 'https://app.example';
  const frame = new FakeWindow(search);
  frame.parent = host;
  childOf.set(host, frame);
  return { host, frame };
}

export const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
