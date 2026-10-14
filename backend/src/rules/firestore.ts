/**
 * firestore.rules and storage.rules, enforced by this server (a VM has no
 * Firestore/Storage servers to do it). The same files the Firebase deploy
 * uploads; read once, from backend/ (two levels above src/rules and
 * lib/rules alike).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import { allowed, RulePath, type Lookup, type Resource, type RulesRequest } from './evaluate.js';
import { parseRules, type Ruleset } from './parse.js';

export const DOCS_PREFIX = ['databases', '(default)', 'documents'];

const cache = new Map<string, Ruleset>();
function ruleset(file: 'firestore.rules' | 'storage.rules'): Ruleset {
  let rs = cache.get(file);
  if (!rs) {
    const path = fileURLToPath(new URL(`../../${file}`, import.meta.url));
    rs = parseRules(
      readFileSync(
        process.env[`TM_RULES_${file === 'firestore.rules' ? 'FIRESTORE' : 'STORAGE'}`] || path,
        'utf8',
      ),
    );
    cache.set(file, rs);
  }
  return rs;
}

/** A document as rules see it. */
export function asResource(
  path: string,
  data: Record<string, unknown> | undefined | null,
): Resource | null {
  if (!data) return null;
  return {
    data,
    id: path.split('/').pop(),
    __name__: new RulePath([...DOCS_PREFIX, ...path.split('/')]),
  };
}

/** get()/exists() in rules read the live database through the db port. */
export const dbLookup: Lookup = {
  async get(segs: string[]) {
    const path = segs.slice(DOCS_PREFIX.length).join('/');
    if (!path || path.split('/').length % 2 !== 0) return null;
    const snap = await db().doc(path).get();
    return snap.exists ? asResource(path, snap.data() as Record<string, unknown>) : null;
  },
};

export interface RulesAuth {
  uid: string;
  token: Record<string, unknown>;
}

/** May `auth` do `method` on the document at `path` (resource = now, after = the result of a write)? */
export function firestoreAllows(
  auth: RulesAuth | null,
  method: 'get' | 'list' | 'create' | 'update' | 'delete',
  path: string,
  resource: Record<string, unknown> | null | undefined,
  after?: Record<string, unknown> | null,
): Promise<boolean> {
  const full = `/${[...DOCS_PREFIX, ...path.split('/')].join('/')}`;
  const request: RulesRequest = {
    auth,
    method,
    path: full,
    time: { toMillis: () => Date.now() },
    resource: after === undefined ? null : asResource(path, after),
  };
  return allowed(ruleset('firestore.rules'), {
    path: full,
    method,
    request,
    resource: asResource(path, resource),
    lookup: dbLookup,
  });
}

/** May `auth` do `method` on the stored object `name` (resource = the object now, after = the upload)? */
export function storageAllows(
  auth: RulesAuth | null,
  method: 'get' | 'list' | 'create' | 'update' | 'delete',
  bucket: string,
  name: string,
  resource: Resource | null,
  after?: Resource | null,
): Promise<boolean> {
  const full = `/b/${bucket}/o/${name}`;
  return allowed(ruleset('storage.rules'), {
    path: full,
    method,
    request: {
      auth,
      method,
      path: full,
      time: { toMillis: () => Date.now() },
      resource: after ?? null,
    },
    resource,
    lookup: { get: async () => null },
    firestore: dbLookup,
  });
}
