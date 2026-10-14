/**
 * THE PORT CONFORMANCE SUITE — one set of expectations, run against every
 * database adapter:
 *
 *   test/db/port.test.ts       SQLite, in memory (unit project, no emulator)
 *   test/db/port.emu.test.ts   Firestore, on the emulator
 *
 * Firestore is the reference: a case here passes on the emulator first, and
 * the SQLite adapter is correct when it gives the same answer. A new adapter
 * (Postgres …) gets a third runner file and nothing else.
 *
 * Every case writes under its own unique collection ids, so the suite can
 * share an emulator with the rest of the emu tests.
 */
import { describe, expect, it } from 'vitest';
import type { DbAdapter, DocumentData, FirestoreDataConverter } from '../../src/db/types.js';

let n = 0;
const uniq = (p: string) =>
  `${p}${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function portSuite(label: string, adapter: () => DbAdapter): void {
  describe(`db port: ${label}`, () => {
    const db = () => adapter().db();
    const FV = () => adapter().FieldValue;
    const FP = () => adapter().FieldPath;
    const TS = () => adapter().Timestamp;

    // ─── documents ──────────────────────────────────────────────────────────

    it('set / get / delete, missing docs', async () => {
      const ref = db().collection(uniq('c')).doc('a');
      expect((await ref.get()).exists).toBe(false);
      expect((await ref.get()).data()).toBeUndefined();
      await ref.set({
        x: 1,
        s: 'hi',
        b: true,
        n: null,
        arr: [1, 'two'],
        m: { k: 'v' },
        u: undefined,
      });
      const snap = await ref.get();
      expect(snap.exists).toBe(true);
      expect(snap.id).toBe('a');
      expect(snap.ref.path).toBe(ref.path);
      expect(snap.data()).toEqual({
        x: 1,
        s: 'hi',
        b: true,
        n: null,
        arr: [1, 'two'],
        m: { k: 'v' },
      });
      expect(snap.get('m.k')).toBe('v');
      expect(snap.updateTime).toBeDefined();
      await ref.delete();
      expect((await ref.get()).exists).toBe(false);
    });

    it('create refuses an existing doc (code 6); update refuses a missing one (code 5)', async () => {
      const ref = db().collection(uniq('c')).doc('a');
      await ref.create({ v: 1 });
      await expect(ref.create({ v: 2 })).rejects.toMatchObject({ code: 6 });
      await expect(db().collection(uniq('c')).doc('nope').update({ v: 1 })).rejects.toMatchObject({
        code: 5,
      });
      expect((await ref.get()).data()).toEqual({ v: 1 });
    });

    it('set merge is deep; plain set replaces', async () => {
      const ref = db().collection(uniq('c')).doc('a');
      await ref.set({ a: 1, m: { x: 1, y: 2 } });
      await ref.set({ b: 2, m: { y: 3, z: 4 } }, { merge: true });
      expect((await ref.get()).data()).toEqual({ a: 1, b: 2, m: { x: 1, y: 3, z: 4 } });
      await ref.set({ only: true });
      expect((await ref.get()).data()).toEqual({ only: true });
    });

    it('set mergeFields writes only the named fields', async () => {
      const ref = db().collection(uniq('c')).doc('a');
      await ref.set({ a: 1, b: 1, m: { x: 1 } });
      await ref.set({ a: 2, b: 2, m: { x: 2, y: 2 } }, { mergeFields: ['a', 'm.y'] });
      expect((await ref.get()).data()).toEqual({ a: 2, b: 1, m: { x: 1, y: 2 } });
    });

    it('update: dotted paths, FieldPath keys, varargs form, map values replace', async () => {
      const ref = db().collection(uniq('c')).doc('a');
      await ref.set({ m: { x: 1, y: 1 }, keep: 1, r: { a: 1, b: 1 } });
      await ref.update({ 'm.x': 2, r: { a: 9 } });
      await ref.update(new (FP())('odd.key', 'in'), 'v', 'keep', 5);
      expect((await ref.get()).data()).toEqual({
        m: { x: 2, y: 1 },
        keep: 5,
        r: { a: 9 },
        'odd.key': { in: 'v' },
      });
    });

    it('sentinels: increment, arrayUnion, arrayRemove, delete, serverTimestamp', async () => {
      const ref = db().collection(uniq('c')).doc('a');
      await ref.set({ n: 1, tags: ['a', 'b'], gone: 1, m: { c: 1 } });
      await ref.update({
        n: FV().increment(2),
        fresh: FV().increment(5),
        'm.c': FV().increment(-1),
        tags: FV().arrayUnion('b', 'c'),
        gone: FV().delete(),
        at: FV().serverTimestamp(),
      });
      await ref.update({ tags: FV().arrayRemove('a') });
      const d = (await ref.get()).data()!;
      expect(d.n).toBe(3);
      expect(d.fresh).toBe(5);
      expect(d.m).toEqual({ c: 0 });
      expect(d.tags).toEqual(['b', 'c']);
      expect('gone' in d).toBe(false);
      expect(d.at).toBeInstanceOf(TS());
      expect(Math.abs(d.at.toMillis() - Date.now())).toBeLessThan(60_000);
      await ref.set({ n: FV().increment(1), list: FV().arrayUnion(1) }, { merge: true });
      const e = (await ref.get()).data()!;
      expect(e.n).toBe(4);
      expect(e.list).toEqual([1]);
    });

    it('timestamps round-trip and compare', async () => {
      const col = db().collection(uniq('c'));
      const t0 = TS().fromMillis(Date.UTC(2026, 0, 1));
      await col.doc('a').set({ at: t0 });
      await col.doc('b').set({ at: TS().fromDate(new Date(Date.UTC(2026, 5, 1))) });
      const got = (await col.doc('a').get()).data()!.at;
      expect(got).toBeInstanceOf(TS());
      expect(got.toMillis()).toBe(t0.toMillis());
      expect(got.isEqual(t0)).toBe(true);
      const q = await col.where('at', '<', TS().fromMillis(Date.UTC(2026, 2, 1))).get();
      expect(q.docs.map((d) => d.id)).toEqual(['a']);
    });

    // ─── queries ────────────────────────────────────────────────────────────

    async function seed() {
      const col = db().collection(uniq('q'));
      const rows: [string, DocumentData][] = [
        ['a', { n: 1, s: 'apple', tags: ['x', 'y'], state: 'active', grp: 1 }],
        ['b', { n: 2, s: 'banana', tags: ['y'], state: 'active', grp: 1 }],
        ['c', { n: 3, s: 'cherry', tags: [], state: 'done', grp: 2 }],
        ['d', { n: 4, s: 'date', state: 'active', grp: 2, opt: null }],
        ['e', { s: 'elder', tags: ['z'], state: 'archived', grp: 3, opt: 'set' }],
      ];
      await Promise.all(rows.map(([id, d]) => col.doc(id).set(d)));
      return col;
    }
    const ids = (s: { docs: { id: string }[] }) => s.docs.map((d) => d.id);

    it('where ==, !=, ranges, in, not-in (missing fields excluded)', async () => {
      const col = await seed();
      expect(ids(await col.where('state', '==', 'active').orderBy('n').get())).toEqual([
        'a',
        'b',
        'd',
      ]);
      expect(ids(await col.where('n', '>', 1).get())).toEqual(['b', 'c', 'd']);
      expect(ids(await col.where('n', '<=', 2).get())).toEqual(['a', 'b']);
      expect(ids(await col.where('n', '!=', 2).get())).toEqual(['a', 'c', 'd']);
      expect(ids(await col.where('state', 'in', ['done', 'archived']).get())).toEqual(['c', 'e']);
      // not-in is an inequality: it orders by its field (archived < done).
      expect(ids(await col.where('state', 'not-in', ['active']).get())).toEqual(['e', 'c']);
      expect(ids(await col.where('opt', '==', null).get())).toEqual(['d']);
      expect(ids(await col.where('opt', '!=', null).get())).toEqual(['e']);
      // A string never compares with a number.
      expect(ids(await col.where('n', '>', 'a').get())).toEqual([]);
    });

    it('array-contains, array-contains-any', async () => {
      const col = await seed();
      expect(ids(await col.where('tags', 'array-contains', 'y').get())).toEqual(['a', 'b']);
      expect(ids(await col.where('tags', 'array-contains-any', ['x', 'z']).get())).toEqual([
        'a',
        'e',
      ]);
    });

    it('orderBy asc/desc, ties by id, missing field excluded; limit, limitToLast, offset', async () => {
      const col = await seed();
      expect(ids(await col.orderBy('n', 'desc').get())).toEqual(['d', 'c', 'b', 'a']);
      expect(ids(await col.orderBy('grp').orderBy('s', 'desc').get())).toEqual([
        'b',
        'a',
        'd',
        'c',
        'e',
      ]);
      expect(ids(await col.orderBy('grp', 'desc').get())).toEqual(['e', 'd', 'c', 'b', 'a']);
      expect(ids(await col.orderBy('n').limit(2).get())).toEqual(['a', 'b']);
      expect(ids(await col.orderBy('n').limitToLast(2).get())).toEqual(['c', 'd']);
      expect(ids(await col.orderBy('n').offset(1).limit(2).get())).toEqual(['b', 'c']);
      expect(ids(await col.get())).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('cursors: values and snapshots', async () => {
      const col = await seed();
      expect(ids(await col.orderBy('n').startAfter(2).get())).toEqual(['c', 'd']);
      expect(ids(await col.orderBy('n').startAt(2).endBefore(4).get())).toEqual(['b', 'c']);
      expect(ids(await col.orderBy('n').endAt(2).get())).toEqual(['a', 'b']);
      const b = await col.doc('b').get();
      expect(ids(await col.orderBy('n').startAfter(b).get())).toEqual(['c', 'd']);
      expect(ids(await col.orderBy('grp').startAfter(b).get())).toEqual(['c', 'd', 'e']);
      expect(ids(await col.orderBy('grp', 'desc').startAfter(b).get())).toEqual(['a']);
      // Paging the way the code does: limit + startAfter(last).
      const p1 = await col.orderBy('s').limit(2).get();
      const p2 = await col.orderBy('s').startAfter(p1.docs[1]!).limit(2).get();
      expect([...ids(p1), ...ids(p2)]).toEqual(['a', 'b', 'c', 'd']);
    });

    it('documentId(): where, orderBy, in', async () => {
      const col = await seed();
      const id = FP().documentId();
      expect(ids(await col.where(id, '<=', 'b').orderBy(id).get())).toEqual(['a', 'b']);
      expect(ids(await col.where(id, 'in', ['c', 'a', 'zz']).get())).toEqual(['a', 'c']);
      expect(ids(await col.orderBy(id).startAfter('c').get())).toEqual(['d', 'e']);
    });

    it('count() and select()', async () => {
      const col = await seed();
      expect((await col.count().get()).data().count).toBe(5);
      expect((await col.where('state', '==', 'active').count().get()).data().count).toBe(3);
      expect((await col.where('state', '==', 'active').limit(2).count().get()).data().count).toBe(
        2,
      );
      const sel = await col.where('state', '==', 'done').select('s').get();
      expect(sel.docs.map((d) => d.data())).toEqual([{ s: 'cherry' }]);
      const none = await col.where('state', '==', 'done').select().get();
      expect(none.size).toBe(1);
      expect(none.docs[0]!.data()).toEqual({});
    });

    it('where on a map value and an array value (equality)', async () => {
      const col = db().collection(uniq('c'));
      await col.doc('a').set({ m: { k: 1 }, arr: [1, 2] });
      await col.doc('b').set({ m: { k: 2 }, arr: [2, 1] });
      expect(ids(await col.where('m', '==', { k: 1 }).get())).toEqual(['a']);
      expect(ids(await col.where('arr', '==', [2, 1]).get())).toEqual(['b']);
      expect(ids(await col.where('arr', 'array-contains', 2).get())).toEqual(['a', 'b']);
    });

    it('collection groups span parents (and board / memory files)', async () => {
      const cid = uniq('g');
      const b1 = uniq('b');
      const b2 = uniq('b');
      await db().doc(`boards/${b1}/${cid}/x1`).set({ who: 'u1', n: 1 });
      await db().doc(`boards/${b2}/${cid}/x2`).set({ who: 'u1', n: 2 });
      await db().doc(`boards/${b2}/${cid}/x3`).set({ who: 'u2', n: 3 });
      await db()
        .doc(`users/${uniq('u')}/${cid}/x4`)
        .set({ who: 'u1', n: 4 });
      const g = await db().collectionGroup(cid).where('who', '==', 'u1').orderBy('n', 'desc').get();
      expect(ids(g)).toEqual(['x4', 'x2', 'x1']);
      expect(g.docs[1]!.ref.path).toBe(`boards/${b2}/${cid}/x2`);
      expect(g.docs[1]!.ref.parent.parent!.path).toBe(`boards/${b2}`);
      expect(ids(await db().collectionGroup(cid).orderBy('n').limit(2).get())).toEqual([
        'x1',
        'x2',
      ]);
      expect((await db().collectionGroup(cid).count().get()).data().count).toBe(4);
    });

    // ─── transactions, batches ──────────────────────────────────────────────

    it('transaction: read-modify-write; reads before writes', async () => {
      const ref = db().collection(uniq('c')).doc('ctr');
      await ref.set({ n: 0 });
      const out = await db().runTransaction(async (tx) => {
        const s = await tx.get(ref);
        tx.update(ref, { n: (s.data()!.n as number) + 1 });
        return 'ok';
      });
      expect(out).toBe('ok');
      expect((await ref.get()).data()).toEqual({ n: 1 });
    });

    it('transaction: concurrent increments all land (retry on contention)', async () => {
      const ref = db().collection(uniq('c')).doc('ctr');
      await ref.set({ n: 0 });
      await Promise.all(
        Array.from({ length: 5 }, () =>
          db().runTransaction(
            async (tx) => {
              const s = await tx.get(ref);
              await new Promise((r) => setTimeout(r, 5));
              tx.set(ref, { n: (s.data()!.n as number) + 1 });
            },
            { maxAttempts: 20 },
          ),
        ),
      );
      expect((await ref.get()).data()).toEqual({ n: 5 });
    });

    it('transaction: a throw writes nothing; tx.getAll and query reads', async () => {
      const col = db().collection(uniq('c'));
      await col.doc('a').set({ v: 1 });
      await expect(
        db().runTransaction(async (tx) => {
          tx.set(col.doc('b'), { v: 2 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await col.doc('b').get()).exists).toBe(false);
      await db().runTransaction(async (tx) => {
        const [a, missing] = await tx.getAll(col.doc('a'), col.doc('zz'));
        expect(a!.data()).toEqual({ v: 1 });
        expect(missing!.exists).toBe(false);
        const q = await tx.get(col.where('v', '==', 1));
        expect(q.size).toBe(1);
        tx.create(col.doc('c'), { v: 3 });
        tx.delete(col.doc('a'));
      });
      expect(ids(await col.get())).toEqual(['c']);
    });

    it('batch: all or nothing', async () => {
      const col = db().collection(uniq('c'));
      await col.doc('a').set({ v: 1 });
      const bad = db().batch();
      bad.set(col.doc('b'), { v: 2 });
      bad.create(col.doc('a'), { v: 9 }); // exists → the whole batch fails
      await expect(bad.commit()).rejects.toMatchObject({ code: 6 });
      expect((await col.doc('b').get()).exists).toBe(false);
      const ok = db().batch();
      ok.set(col.doc('b'), { v: 2 })
        .update(col.doc('a'), { v: FV().increment(1) })
        .delete(col.doc('zz'));
      expect(await ok.commit()).toHaveLength(3);
      expect((await col.get()).docs.map((d) => d.data())).toEqual([{ v: 2 }, { v: 2 }]);
    });

    it('getAll keeps order and reports missing docs', async () => {
      const col = db().collection(uniq('c'));
      await col.doc('a').set({ v: 1 });
      await col.doc('b').set({ v: 2 });
      const snaps = await db().getAll(col.doc('b'), col.doc('x'), col.doc('a'));
      expect(snaps.map((s) => (s.exists ? s.data()!.v : null))).toEqual([2, null, 1]);
    });

    it('bulkWriter + recursiveDelete (document with subcollections)', async () => {
      const root = uniq('r');
      const w = db().bulkWriter();
      void w.set(db().doc(`${root}/a`), { v: 1 });
      void w.set(db().doc(`${root}/a/sub/1`), { v: 2 });
      void w.set(db().doc(`${root}/a/sub/1/deeper/x`), { v: 3 });
      void w.set(db().doc(`${root}/b`), { v: 4 });
      await w.close();
      expect((await db().doc(`${root}/a`).listCollections()).map((c) => c.id)).toEqual(['sub']);
      await db().recursiveDelete(db().doc(`${root}/a`));
      expect((await db().doc(`${root}/a`).get()).exists).toBe(false);
      expect((await db().doc(`${root}/a/sub/1/deeper/x`).get()).exists).toBe(false);
      expect((await db().doc(`${root}/b`).get()).exists).toBe(true);
    });

    it('recursiveDelete of a board drops its whole subtree', async () => {
      const b = uniq('b');
      const sub = uniq('t');
      await db().doc(`boards/${b}`).set({ name: 'B' });
      await db().doc(`boards/${b}/${sub}/t1`).set({ v: 1 });
      await db().doc(`boards/${b}/${sub}/t1/messages/m1`).set({ v: 2 });
      await db().recursiveDelete(db().doc(`boards/${b}`));
      expect((await db().doc(`boards/${b}`).get()).exists).toBe(false);
      expect((await db().collection(`boards/${b}/${sub}`).get()).size).toBe(0);
      expect((await db().collectionGroup(sub).get()).size).toBe(0);
    });

    it('listDocuments includes parents that only have subcollections', async () => {
      const root = uniq('r');
      await db().doc(`${root}/real`).set({ v: 1 });
      await db().doc(`${root}/ghost/sub/x`).set({ v: 1 });
      const docs = await db().collection(root).listDocuments();
      expect(docs.map((d) => d.id).sort()).toEqual(['ghost', 'real']);
    });

    // ─── converters, refs, values ───────────────────────────────────────────

    it('withConverter on doc, collection and query', async () => {
      type Row = { name: string; seen: boolean };
      const conv: FirestoreDataConverter<Row> = {
        toFirestore: (m: unknown) => ({ ...(m as object), _v: 1 }),
        fromFirestore: (s) => ({ name: String(s.data().name).toUpperCase(), seen: true }),
      };
      const col = db().collection(uniq('c')).withConverter(conv);
      await col.doc('a').set({ name: 'ann', seen: false });
      expect((await col.doc('a').get()).data()).toEqual({ name: 'ANN', seen: true });
      expect((await db().doc(col.doc('a').path).get()).data()).toEqual({
        name: 'ann',
        seen: false,
        _v: 1,
      });
      expect((await col.where('name', '==', 'ann').get()).docs[0]!.data().name).toBe('ANN');
      const plain = col.withConverter(null);
      expect((await plain.doc('a').get()).data()!._v).toBe(1);
    });

    it('refs: ids, parents, auto ids, references stored as values', async () => {
      const col = db().collection(uniq('c'));
      const ref = col.doc();
      expect(ref.id).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(ref.parent.path).toBe(col.path);
      expect(col.parent).toBeNull();
      const added = await col.add({ v: 1 });
      expect((await added.get()).data()).toEqual({ v: 1 });
      await col.doc('p').set({ link: added });
      const link = (await col.doc('p').get()).data()!.link;
      expect(link).toBeInstanceOf(adapter().DocumentReference);
      expect(link.path).toBe(added.path);
      expect(link.isEqual(added)).toBe(true);
    });

    it('a document over 1 MiB is refused (code 3)', async () => {
      const ref = db().collection(uniq('c')).doc('big');
      await expect(ref.set({ blob: 'x'.repeat(1_100_000) })).rejects.toMatchObject({ code: 3 });
      expect((await ref.get()).exists).toBe(false);
    });
  });
}
