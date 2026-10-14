/**
 * THE REALTIME-DATABASE PORT CONFORMANCE SUITE — Firebase's RTDB (the
 * emulator, the reference) and the local JSON tree must answer alike.
 */
import { describe, expect, it } from 'vitest';
import type { RealtimeDb } from '../../src/rtdb/types.js';

let n = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export function rtdbSuite(label: string, db: () => RealtimeDb, TIMESTAMP: () => object): void {
  describe(`rtdb port: ${label}`, () => {
    it('set / get / exists / remove; null deletes and empty parents vanish', async () => {
      const root = db().ref(uniq('t'));
      await root.child('a/b').set({ x: 1, y: 'two', z: true });
      expect((await root.child('a/b').get()).val()).toEqual({ x: 1, y: 'two', z: true });
      expect((await root.child('missing').get()).exists()).toBe(false);
      expect((await root.child('missing').get()).val()).toBe(null);
      await root.child('a/b/x').set(null);
      expect((await root.child('a/b').get()).val()).toEqual({ y: 'two', z: true });
      await root.child('a/b').remove();
      expect((await root.child('a').get()).exists()).toBe(false);
    });

    it('update: multi-path keys, null removes', async () => {
      const root = db().ref(uniq('u'));
      await root.set({ keep: 1, gone: 2, nest: { a: 1 } });
      await root.update({ 'nest/b': 2, gone: null, added: 'yes' });
      expect((await root.get()).val()).toEqual({ keep: 1, nest: { a: 1, b: 2 }, added: 'yes' });
    });

    it('push: keys sort by time', async () => {
      const list = db().ref(uniq('p'));
      const keys: string[] = [];
      for (let i = 0; i < 5; i++) keys.push((await list.push({ i })).key!);
      expect([...keys].sort()).toEqual(keys);
      expect(Object.keys((await list.get()).val() as object)).toHaveLength(5);
    });

    it('transaction: commit, and abort with undefined', async () => {
      const c = db().ref(uniq('c'));
      const r1 = await c.transaction((cur: number | null) => (cur ?? 0) + 1);
      expect(r1.committed).toBe(true);
      expect(r1.snapshot.val()).toBe(1);
      const r2 = await c.transaction(() => undefined);
      expect(r2.committed).toBe(false);
      expect((await c.get()).val()).toBe(1);
    });

    it('ServerValue.TIMESTAMP is the server clock', async () => {
      const r = db().ref(uniq('ts'));
      await r.set({ at: TIMESTAMP() });
      const at = ((await r.get()).val() as { at: number }).at;
      expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
    });

    it('refuses keys with . $ # [ ]', () => {
      expect(() => db().ref(uniq('k')).child('a.b')).toThrow();
    });
  });
}
