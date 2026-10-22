/**
 * Kit artifacts reach the stores through THE BROKER, over the kit's bridge.
 * These tests drive the real kit endpoint (a MessageChannel, as in the
 * browser) against the real broker and a recording fake of the stores, and
 * check that the broker's promises still hold: our prefix on every path,
 * read-only refused, streams that open and close listeners, errors with codes.
 */
import { describe, expect, it } from 'vitest';
import { createEndpoint, type Remote } from '@panth977/sandbox/bridge';
import type { ArtifactRole } from '@tm/shared';
import { createBroker, type BrokerBackend, type StoredDoc } from '../broker';
import { fakeTickets } from '../fakeTickets';
import { createBrokerLink, createKitApi, type KitApi } from './bridgeApi';

const ID = 'artKIT0001';
const UID = 'user-1';
const FS = `artifacts/${ID}/db/data`;

function fake() {
  const calls: string[] = [];
  const docs = new Map<string, Record<string, unknown>>();
  const live: { path: string; next: (v: never) => void; stopped: boolean }[] = [];
  const listen = (op: string, path: string, next: (v: never) => void) => {
    calls.push(`${op} ${path}`);
    const l = { path, next, stopped: false };
    live.push(l);
    return () => void (l.stopped = true);
  };
  const backend = {
    fs: {
      codec: { date: (d: Date) => d.getTime(), serverTime: () => ({ now: true }) },
      asDate: () => null,
      async get(path: string): Promise<StoredDoc> {
        calls.push(`fs.get ${path}`);
        const data = docs.get(path) ?? null;
        return { exists: !!data, data };
      },
      async set(path: string, data: Record<string, unknown>) {
        calls.push(`fs.set ${path}`);
        docs.set(path, data);
      },
      async update() {},
      async delete() {},
      async add() {
        return 'x';
      },
      async list() {
        return [];
      },
      onDoc: (path: string, next: (v: never) => void) => listen('fs.onDoc', path, next),
      onList: (path: string, _q: unknown, next: (v: never) => void) =>
        listen('fs.onList', path, next),
    },
    rtdb: {
      codec: {
        date: (d: Date) => d.getTime(),
        serverTime: () => ({}),
        key: () => {},
        finiteOnly: true,
      },
      async get() {
        return 7;
      },
      async set() {},
      async update() {},
      async push() {
        return 'k';
      },
      async remove() {},
      on: (path: string, next: (v: never) => void) => listen('rtdb.on', path, next),
    },
    storage: { async upload() {} },
    files: {
      async url() {
        return { url: 'u', expiresAt: 1 };
      },
      async list() {
        return [];
      },
      async delete() {},
    },
    tickets: fakeTickets(UID).backend,
  } as unknown as BrokerBackend;
  return { backend, calls, docs, live };
}

function setup(o: { role?: ArtifactRole; readOnly?: boolean } = {}) {
  const f = fake();
  const link = createBrokerLink();
  const toasts: string[] = [];
  const broker = createBroker({
    artifactId: ID,
    uid: UID,
    frame: () => link.frame,
    artifact: () => ({ name: 'Kit', buildId: 'b1' }),
    viewer: () => ({ name: 'Asha', email: 'a@x', photoURL: null }),
    role: o.role ?? 'editor',
    readOnly: o.readOnly ?? false,
    backend: f.backend,
  });
  link.connect(broker);
  const api = createKitApi(link, { toast: (m) => toasts.push(m), open: () => {} });
  const ch = new MessageChannel();
  const host = createEndpoint(ch.port1, { expose: api });
  const art = createEndpoint<KitApi>(ch.port2);
  const remote = art.remote as Remote<KitApi>;
  return {
    ...f,
    broker,
    link,
    remote,
    toasts,
    close: () => (host.close(), art.close(), link.close()),
  };
}

describe('kit bridge → broker', () => {
  it('reads and writes under THIS artifact only', async () => {
    const t = setup();
    await t.remote.db.set('/orders/o1', { n: 1 });
    const doc = await t.remote.db.get('/orders/o1');
    expect(doc).toMatchObject({ id: 'o1', path: '/orders/o1', exists: true, data: { n: 1 } });
    expect(t.calls).toEqual([`fs.set ${FS}/orders/o1`, `fs.get ${FS}/orders/o1`]);
    await expect(t.remote.db.get('/../../x')).rejects.toMatchObject({ code: 'invalid-argument' });
    t.close();
  });

  it('a read-only viewer is refused before any call', async () => {
    const t = setup({ role: 'viewer', readOnly: true });
    await expect(t.remote.db.set('/a/b', { n: 1 })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(t.calls).toEqual([]);
    expect(await t.remote.rtdb.get('/x')).toBe(7);
    t.close();
  });

  it('me() and artifact() come from the broker hello', async () => {
    const t = setup();
    expect(await t.remote.me()).toMatchObject({
      uid: UID,
      name: 'Asha',
      role: 'editor',
      readOnly: false,
    });
    expect(await t.remote.artifact()).toMatchObject({ id: ID, name: 'Kit', buildId: 'b1' });
    t.close();
  });

  it('watch streams snapshots and closing it stops the listener', async () => {
    const t = setup();
    const seen: unknown[] = [];
    const it = (async () => {
      for await (const d of t.remote.db.watch('/live/x')) {
        seen.push(d);
        if (seen.length === 2) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.live).toHaveLength(1);
    t.live[0]!.next({ exists: true, data: { v: 1 } } as never);
    t.live[0]!.next({ exists: true, data: { v: 2 } } as never);
    await it;
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(2);
    expect(t.live[0]!.stopped).toBe(true);
    expect(t.broker.listeners).toBe(0);
    t.close();
  });

  it('revocation fails live streams and every later call', async () => {
    const t = setup();
    const p = (async () => {
      for await (const _ of t.remote.rtdb.watch('/p')) void _;
    })();
    await new Promise((r) => setTimeout(r, 30));
    t.broker.revoke();
    await expect(p).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(t.remote.db.get('/a/b')).rejects.toMatchObject({ code: 'permission-denied' });
    t.close();
  });

  it('host.ui reaches the page', async () => {
    const t = setup();
    await t.remote.ui.toast('Saved', 'success');
    expect(t.toasts).toEqual(['Saved']);
    t.close();
  });
});
