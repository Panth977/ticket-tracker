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
 *
 * Nothing goes out before the server has ACCEPTED that token. A socket that
 * reconnects after a laptop slept still holds an expired one; sent ahead of
 * the answer, the listeners ran signed out, users/{uid} came back denied, and
 * the page took that for "no profile" and sent the person to /welcome. So each
 * new socket asks auth.ts for the token now (setLiveTokenSource — refreshed if
 * it is about to lapse), waits for the server's yes, forces one refresh on a
 * no, and otherwise closes and tries again later.
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
/** auth.ts: the current ID token, refreshed first when it is stale (or `force`). */
type TokenSource = (force: boolean) => Promise<string | null>;
let source: TokenSource | null = null;
export function setLiveTokenSource(fn: TokenSource | null): void {
  source = fn;
}
/** Auth frames waiting for the server's answer: id → accepted? */
const authWaits = new Map<string, (ok: boolean) => void>();

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
        ws.onopen = () =>
          void authenticate(ws).then((ok) => {
            if (socket !== ws || ws.readyState !== WebSocket.OPEN) return resolve();
            // Refused even after a refresh: never carry on signed out. Close;
            // onclose resolves and reconnects with backoff.
            if (!ok) return ws.close();
            backoff = 250;
            // Signed in: send EVERYTHING this page is waiting on — what an
            // earlier socket carried and what never got out (a socket can
            // close before it opens — a sign-in does that — and whatever was
            // queued for it must not be left hanging).
            for (const [lid, s] of subs) {
              ws.send(JSON.stringify({ ...s.msg, id: `s${++seq}`, lid }));
              s.sent = true;
            }
            for (const [id, p] of pending) {
              ws.send(JSON.stringify({ ...p.msg, id }));
              p.sent = true;
            }
            resolve();
          });
        ws.onmessage = (e) => {
          let f: Frame;
          try {
            f = JSON.parse(String(e.data)) as Frame;
          } catch {
            return;
          }
          const waiting = f.id ? authWaits.get(f.id) : undefined;
          if (waiting) {
            authWaits.delete(f.id!);
            return waiting(!!f.ok);
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
          for (const done of authWaits.values()) done(false);
          authWaits.clear();
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

/** Send { op: 'auth' } and wait for the answer: true = accepted. */
function sendAuth(ws: WebSocket, tok: string | null): Promise<boolean> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  const id = `auth${++seq}`;
  const answer = new Promise<boolean>((done) => authWaits.set(id, done));
  ws.send(JSON.stringify({ id, op: 'auth', token: tok }));
  return answer;
}

/** A new socket's handshake: the token as of now, then one forced refresh if refused. */
async function authenticate(ws: WebSocket): Promise<boolean> {
  const current = async (force: boolean) => {
    if (!source) return token;
    try {
      return await source(force);
    } catch {
      return token; // offline, or signed out meanwhile (setLiveToken says which)
    }
  };
  token = await current(false);
  if (await sendAuth(ws, token)) return true;
  if (!token) return false;
  token = await current(true);
  return sendAuth(ws, token);
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
