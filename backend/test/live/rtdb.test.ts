/**
 * The Realtime Database over /live (live/rtdb.ts) on the local tree with the
 * real database.rules.json: presence the way the app writes it, listeners,
 * onDisconnect, push. (The rules evaluator itself is proven equal to
 * Firebase's in qaqc/rules/interpreter.database.test.ts.)
 */
process.env.TM_DB = 'sqlite';
process.env.TM_DB_DIR = ':memory:';
process.env.TM_RTDB_FILE = ':memory:';

import { beforeAll, describe, expect, it } from 'vitest';

/** A frame off the live wire. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = Record<string, any>;

const { DataSession } = await import('../../src/live/data.js');
const { localTree } = await import('../../src/rtdb/local.js');

const B = 'b1';
const session = (uid: string | null) => {
  const out: Frame[] = [];
  const s = new DataSession(uid ? { uid, token: {} } : null, (m) => out.push(m as Frame));
  const ask = async (msg: Frame) => {
    const id = String(Math.random());
    await s.handle({ id, ...msg } as never);
    return out.find((m) => m.id === id)!;
  };
  return { s, out, ask };
};

beforeAll(() => {
  localTree().write([[['boardReaders', B, 'u1'], true], [['boardReaders', B, 'u2'], true]]);
});

describe('rtdb over /live', () => {
  it('presence: a member writes their own, a stranger cannot; invalid shapes refused', async () => {
    const me = session('u1');
    const ok = await me.ask({ op: 'rtdb.set', path: `presence/${B}/u1`, value: { state: 'online', lastChanged: { '.sv': 'timestamp' } } });
    expect(ok.ok).toBe(true);
    expect((await me.ask({ op: 'rtdb.set', path: `presence/${B}/u1`, value: { state: 'busy', lastChanged: 1 } })).error.code).toBe('permission-denied');
    expect((await me.ask({ op: 'rtdb.set', path: `presence/${B}/u2`, value: { state: 'online', lastChanged: 1 } })).error.code).toBe('permission-denied');
    const stranger = session('u9');
    expect((await stranger.ask({ op: 'rtdb.get', path: `presence/${B}` })).error.code).toBe('permission-denied');
    expect((await stranger.ask({ op: 'rtdb.set', path: `presence/${B}/u9`, value: { state: 'online', lastChanged: 1 } })).error.code).toBe('permission-denied');
  });

  it('listen: the value now and on every change; onDisconnect runs when the socket goes', async () => {
    const watcher = session('u2');
    await watcher.ask({ op: 'rtdb.listen', lid: 'p', path: `presence/${B}` });
    const writer = session('u2');
    await writer.ask({ op: 'rtdb.onDisconnect', path: `presence/${B}/u2`, action: 'remove' });
    await writer.ask({ op: 'rtdb.set', path: `presence/${B}/u2`, value: { state: 'away', lastChanged: 1 } });
    const last = () => watcher.out.filter((f) => f.lid === 'p').at(-1)!.value;
    expect(Object.keys(last())).toContain('u2');
    writer.s.close();
    expect(Object.keys(last())).not.toContain('u2');
  });

  it('onDisconnect is checked when registered', async () => {
    const me = session('u1');
    expect((await me.ask({ op: 'rtdb.onDisconnect', path: `presence/${B}/u2`, action: 'remove' })).error.code).toBe('permission-denied');
  });

  it('push answers a key; time answers the server clock', async () => {
    const me = session('u1');
    const r = await me.ask({ op: 'rtdb.push', path: 'silence' });
    expect(r.result.key).toMatch(/^[-\w]{20}$/);
    const t = await me.ask({ op: 'rtdb.time' });
    expect(Math.abs(t.result.now - Date.now())).toBeLessThan(5000);
  });
});
