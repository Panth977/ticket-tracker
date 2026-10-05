/**
 * THE REAL BACKEND: the TaskManager host page (/x/{id}), reached by
 * postMessage (docs/plan/artifacts.html §D3, §E3).
 *
 *   ready ──▶            every 500 ms until the host answers
 *         ◀── hello      who is looking, which artifact, which build
 *   req   ──▶ ◀── res    one Promise per request, matched by id
 *   req   ──▶ ◀── res {sub}, then event… until unsub ──▶
 *         ◀── signal     readonly · revoked · build
 *
 * There is no Firebase here and no session: the artifact runs on an opaque
 * origin, and the only thing this file can cause is a message to its parent.
 * The host decides everything (and the rules decide after it).
 */
import {
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TAG,
  isDriverMessage,
  type DriverArgs,
  type DriverError,
  type DriverOp,
  type DriverResult,
  type FromArtifact,
  type FromHost,
} from '@tm/shared/artifacts/driver';
import {
  BackendDriverError,
  type MessageEventLike,
  type Session,
  type SignalName,
  type SubOp,
  type Transport,
  type WindowLike,
} from './transport.js';

export const READY_EVERY_MS = 500;
/** Framed but nobody answered: say so ONCE in the console and keep waiting. */
export const HINT_AFTER_MS = 5000;

interface ParentLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

type Outgoing =
  | { type: 'ready' }
  | { type: 'req'; id: string; op: DriverOp; args: unknown }
  | { type: 'unsub'; sub: string };

export interface HostConnection {
  /** Resolves with the session once `hello` arrives. Never rejects. */
  session: Promise<Session>;
  /** Stop knocking and stop listening (the driver went to the mock instead). */
  abandon(): void;
}

export function connectHost(
  win: WindowLike,
  onSignal: (name: SignalName, value: unknown) => void,
): HostConnection {
  const parent = win.parent as ParentLike;
  /**
   * '*' for the knock: a sandboxed frame cannot know who embeds it. Once the
   * host has answered, its origin is pinned, so what the artifact WRITES is
   * only ever delivered to the page that said hello.
   */
  let hostOrigin = '*';
  let revoked = false;
  let seq = 0;
  // Two tabs of one artifact never share a window, so a per-load prefix is
  // only there to make ids unguessable-enough to tell stale answers apart.
  const prefix = Math.random().toString(36).slice(2, 8);
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  const subs = new Map<
    string,
    { onValue: (v: unknown) => void; onError: (e: DriverError) => void }
  >();

  const post = (msg: Outgoing) => {
    const full = { tag: DRIVER_TAG, v: DRIVER_PROTOCOL_VERSION, ...msg } as FromArtifact;
    parent.postMessage(full, hostOrigin);
  };

  /** One request on the wire. `settled` runs INSIDE the message handler that carries the answer. */
  function send(
    op: DriverOp,
    args: unknown,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ) {
    if (revoked)
      return reject(
        new BackendDriverError('permission-denied', 'You no longer have access to this artifact'),
      );
    const id = `${prefix}-${++seq}`;
    pending.set(id, { resolve, reject });
    try {
      post({ type: 'req', id, op, args });
    } catch (e) {
      // postMessage throws DataCloneError for a value that cannot be cloned
      // (a function, a DOM node): that is the caller's argument, not the host.
      pending.delete(id);
      reject(
        new BackendDriverError('invalid-argument', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  const transport: Transport = {
    request<O extends DriverOp>(op: O, args: DriverArgs<O>): Promise<DriverResult<O>> {
      return new Promise((resolve, reject) =>
        send(op, args, resolve as (v: unknown) => void, reject),
      );
    },
    subscribe<O extends SubOp>(
      op: O,
      args: DriverArgs<O>,
      onValue: (value: unknown) => void,
      onError: (error: DriverError) => void,
    ) {
      let sub: string | null = null;
      let stopped = false;
      /*
       * NOT a Promise: the subscription is registered synchronously, in the
       * very handler that receives { sub }. The host sends the first snapshot
       * right behind that answer, and a `.then` would only run after the
       * current task — leaving a window in which that snapshot finds nobody
       * listening and is dropped.
       */
      send(
        op,
        args,
        (res) => {
          const id = (res as { sub: string }).sub;
          // unsubscribe() ran before the host answered: the listener exists
          // over there and nothing here would ever close it.
          if (stopped) return post({ type: 'unsub', sub: id });
          sub = id;
          subs.set(id, { onValue, onError });
        },
        (e) => {
          if (!stopped) onError(e as DriverError);
        },
      );
      return () => {
        if (stopped) return;
        stopped = true;
        if (sub && subs.delete(sub)) post({ type: 'unsub', sub });
      };
    },
  };

  let settle: (s: Session) => void = () => {};
  const session = new Promise<Session>((r) => (settle = r));
  let greeted = false;
  let me: Session['me'] | null = null;

  const onMessage = (event: MessageEventLike) => {
    // Only the window that frames us may speak; anything else on the page
    // (an ad iframe, a devtools extension) is ignored.
    if (event.source !== parent || !isDriverMessage(event.data)) return;
    const msg = event.data as FromHost;
    switch (msg.type) {
      case 'hello': {
        if (greeted) return;
        greeted = true;
        clearInterval(knock);
        clearTimeout(hint);
        if (event.origin && event.origin !== 'null') hostOrigin = event.origin;
        me = { ...msg.me };
        settle({ transport, me, artifact: { ...msg.artifact }, mock: false });
        return;
      }
      case 'res': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(msg.error);
        return;
      }
      case 'event': {
        const s = subs.get(msg.sub);
        if (!s) return;
        if (msg.ok) s.onValue(msg.value);
        else {
          // An error ends a subscription on the host; forget it here too.
          subs.delete(msg.sub);
          s.onError(msg.error);
        }
        return;
      }
      case 'signal': {
        if (msg.name === 'readonly' && me) me.readOnly = msg.value === true;
        if (msg.name === 'revoked') {
          revoked = true;
          subs.clear();
        }
        onSignal(msg.name, msg.value);
        return;
      }
    }
  };
  win.addEventListener('message', onMessage as (e: never) => void);

  const knockOnce = () => {
    try {
      post({ type: 'ready' });
    } catch {
      /* a parent that refuses the message is the same as one that never answers */
    }
  };
  const knock = setInterval(knockOnce, READY_EVERY_MS);
  const hint = setTimeout(() => {
    console.warn(
      '[BackendDriver] Still waiting for the TaskManager host page. An artifact only runs when opened at /x/{id}; ' +
        'to develop it on your machine open it as a top-level page (the mock backend starts by itself), or add ?mock=1.',
    );
  }, HINT_AFTER_MS);
  knockOnce();

  return {
    session,
    abandon() {
      clearInterval(knock);
      clearTimeout(hint);
      win.removeEventListener('message', onMessage as (e: never) => void);
    },
  };
}
