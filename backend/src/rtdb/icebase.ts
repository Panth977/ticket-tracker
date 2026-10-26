/**
 * IceBase's Realtime Database as the admin (database.rules.json does not apply) — Firebase's on
 * Firebase, the IceBase server's on it (TM_ICEBASE) — behind the Admin SDK-shaped port.
 */
import { FieldValue, type DatabaseDriver, type RawDbSnapshot } from '@panth977/icebase/internal';
import { getAdminDatabase } from '@panth977/icebase-server/admin';
import { icebaseApp } from '../icebase/app.js';
import type { DataSnapshot, RealtimeDb, Reference, RtdbAdapter, TransactionResult } from './types.js';

let driver: DatabaseDriver | undefined;
const d = (): DatabaseDriver => (driver ??= (getAdminDatabase(icebaseApp()) as unknown as { _driver: DatabaseDriver })._driver);

/** A path's keys: never empty, never . $ # [ ] (the Realtime Database's rule, as the Admin SDK checks it). */
const clean = (p: string) => {
  const keys = p.split('/').filter((s) => s !== '');
  for (const k of keys) if (/[.$#[\]]/.test(k)) throw new Error(`Invalid key "${k}" in "${p}": keys can't contain ".", "#", "$", "[", or "]"`);
  return keys.join('/');
};

function snap(key: string | null, raw: RawDbSnapshot): DataSnapshot {
  const value = raw.value ?? null;
  return { key, val: () => value, exists: () => value !== null };
}

function ref(path: string): Reference {
  const key = path ? path.slice(path.lastIndexOf('/') + 1) : null;
  return {
    key,
    child: (p) => ref(clean(`${path}/${p}`)),
    get: async () => snap(key, await d().get(path, null)),
    set: (value) => d().set(path, value ?? null),
    update: (values) => d().update(path, values),
    remove: () => d().remove(path),
    push(value?: unknown) {
      const child = ref(clean(`${path}/${d().newKey(path)}`));
      const done = value === undefined ? Promise.resolve(child) : child.set(value).then(() => child);
      // Resolves to a plain reference (not itself thenable), as the Admin SDK's does.
      return Object.assign(Object.create(child) as Reference, { then: done.then.bind(done), catch: done.catch.bind(done) }) as Reference & Promise<Reference>;
    },
    async transaction(update, _onComplete, applyLocally = true): Promise<TransactionResult> {
      const r = await d().transaction(path, (cur) => update(cur as never), applyLocally);
      return { committed: r.committed, snapshot: snap(key, r.snapshot) };
    },
  };
}

export const icebaseRtdb: RtdbAdapter = {
  name: 'icebase',
  db: (): RealtimeDb => ({ ref: (path = '') => ref(clean(path)) }),
  TIMESTAMP: new FieldValue('serverTime'),
};
