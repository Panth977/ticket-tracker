/**
 * THE VM BUILD'S LINE TO ITS SERVER — one WebSocket to /live (backend
 * src/server.ts) that carries every Firestore-shaped and RTDB-shaped call the
 * shims in this folder make (backend src/live/data.ts and rtdb.ts).
 *
 *   request({ op, … })            → Promise of the result
 *   subscribe({ op, … }, onFrame) → unsubscribe; survives reconnects
 *
 * The socket authenticates with the signed-in user's ID token (auth.ts tells
 * it via setLiveToken) and re-sends every live subscription after a
 * reconnect or a sign-in change, so a listener never silently goes stale.
 */

type Frame = Record<string, unknown> & { id?: string; lid?: string };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; msg: Frame; sent: boolean };

let socket: WebSocket | null = null;
let ready: Promise<void> | null = null;
let token: string | null = null;
let seq = 0;
const pending = new Map<string, Pending>();
const subs = new Map<string, { msg: Frame; onFrame: (f: Frame) => void; sent: boolean }>();
let backoff = 250;
/** auth.ts holds the first connect until the device's session is restored. */
let gate: Promise<unknown> = Promise.resolve();
export function holdLiveUntil(p: Promise<unknown>): void {
  gate = p.catch(() => {});
}

export class LiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FirebaseError';
  }
}

function url(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/live`;
}

function connect(): Promise<void> {
  if (ready) return ready;
  ready = gate.then(
    () =>
      new Promise<void>((resolve) => {
        const ws = new WebSocket(url());
        socket = ws;
        ws.onopen = () => {
          backoff = 250;
          // Authenticate first, then send EVERYTHING this page is waiting on:
          // what an earlier socket carried and what never got out (a socket
          // can close before it opens — a sign-in does that — and whatever
          // was queued for it must not be left hanging).
          ws.send(JSON.stringify({ id: `auth${++seq}`, op: 'auth', token }));
          for (const [lid, s] of subs) {
            ws.send(JSON.stringify({ ...s.msg, id: `s${++seq}`, lid }));
            s.sent = true;
          }
          for (const [id, p] of pending) {
            ws.send(JSON.stringify({ ...p.msg, id }));
            p.sent = true;
          }
          resolve();
        };
        ws.onmessage = (e) => {
          let f: Frame;
          try {
            f = JSON.parse(String(e.data)) as Frame;
          } catch {
            return;
          }
          if (f.lid) {
            subs.get(f.lid)?.onFrame(f);
            if (f.error) subs.delete(f.lid);
            return;
          }
          const p = f.id ? pending.get(f.id) : undefined;
          if (!p) return;
          pending.delete(f.id!);
          if (f.ok) p.resolve(f.result);
          else {
            const err = (f.error ?? {}) as { code?: string; message?: string };
            p.reject(new LiveError(err.code ?? 'internal', err.message ?? 'Request failed'));
          }
        };
        ws.onclose = () => {
          if (socket === ws) socket = null;
          ready = null;
          resolve(); // never leave a caller waiting on a socket that is gone
          for (const s of subs.values()) s.sent = false;
          for (const p of pending.values()) p.sent = false;
          // Reconnect while anything is listening or waiting.
          if (subs.size || pending.size)
            setTimeout(() => void connect(), (backoff = Math.min(backoff * 2, 10_000)));
        };
      }),
  );
  return ready;
}

/** The signed-in user changed (or their token refreshed): re-authenticate the socket. */
export function setLiveToken(next: string | null): void {
  if (next === token) return;
  const changedUser = !!token !== !!next;
  token = next;
  if (!socket) return;
  if (socket.readyState === WebSocket.CONNECTING) return; // onopen sends the new token
  if (changedUser) socket.close(); // everything re-subscribes under the new identity
  else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: `auth${++seq}`, op: 'auth', token }));
}

export async function request<T = unknown>(msg: Frame): Promise<T> {
  const id = `r${++seq}`;
  const done = new Promise<T>((resolve, reject) =>
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, msg, sent: false }),
  );
  await connect();
  const p = pending.get(id);
  if (p && !p.sent && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ ...msg, id }));
    p.sent = true;
  }
  return done;
}

export function subscribe(msg: Frame, onFrame: (f: Frame) => void): () => void {
  const lid = `l${++seq}`;
  subs.set(lid, { msg, onFrame, sent: false });
  void connect().then(() => {
    const s = subs.get(lid);
    if (s && !s.sent && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ...msg, id: `s${++seq}`, lid }));
      s.sent = true;
    }
  });
  return () => {
    if (!subs.delete(lid)) return;
    const op = String(msg.op).startsWith('rtdb.') ? 'rtdb.unlisten' : 'unlisten';
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: `u${++seq}`, op, lid }));
  };
}
