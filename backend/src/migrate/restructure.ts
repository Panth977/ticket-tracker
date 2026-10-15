/**
 * THE RESTRUCTURE MIGRATION (agents.html §AC, ORCH-6) — once per database,
 * Firebase or VM, over whatever Firestore-shaped `db` and Storage-shaped
 * `bucket` it is handed (the VM's ports, or the Google Cloud clients the
 * prod script builds), so there is one implementation for both:
 *
 *   1  MEMORY → BUCKET in the data: memories/{m} (+ nodes) move to
 *      buckets/{m}; in every other document keys like memoryId / memoryIds /
 *      attachMemory / memory become bucketId / bucketIds / attachBucket /
 *      bucket, enum values 'memory' (in source / kind) become 'bucket', the
 *      'memory:read|write' scopes become 'bucket:…', and 'memories/…' paths
 *      become 'buckets/…'. Storage objects under memories/ move to buckets/.
 *   2  OWNERS: every person gets a handle; every board gets an owner (its
 *      creator if still an admin, else its first person admin), every
 *      artifact and bucket its owner (ownerUid) and a slug.
 *   3  WORKSPACES → ORGS: each person's workspace becomes an org they own
 *      (handle from its name); the boards, artifacts and buckets in it that
 *      they own move into it. The workspace documents are then removed.
 *   4  NO MORE HIDING: everything lives under its owner in the sidebar, so
 *      the per-person hide lists (users/{uid}/ui/sidebar) are removed.
 *
 * DRY RUN unless `apply`. IDEMPOTENT: a second run plans nothing.
 */
import {
  COLLECTIONS,
  handleFrom,
  ownerKeyOf,
  RESERVED_HANDLES,
  slugify,
  type Org,
  type OwnerRef,
} from '@tm/shared';

/* eslint-disable @typescript-eslint/no-explicit-any -- the handed-in clients are Firestore-shaped, not typed here */
type Db = any;
type Bucket = any;
type Doc = Record<string, unknown>;

export interface RestructureOptions {
  db: Db;
  bucket: Bucket | null;
  apply: boolean;
  log?: (m: string) => void;
  now?: number;
}

export interface RestructureSummary {
  bucketsMoved: number;
  nodesMoved: number;
  docsRewritten: number;
  objectsMoved: number;
  handles: number;
  owners: number;
  orgs: number;
  movedIntoOrgs: number;
  workspacesRemoved: number;
  sidebarsRemoved: number;
}

// ─── 1. the rename in the data ───────────────────────────────────────────────

const KEY_MAP: [string, string][] = [
  ['MEMORIES', 'BUCKETS'],
  ['Memories', 'Buckets'],
  ['memories', 'buckets'],
  ['MEMORY', 'BUCKET'],
  ['Memory', 'Bucket'],
  ['memory', 'bucket'],
];
const renameKey = (k: string) => KEY_MAP.reduce((s, [a, b]) => s.split(a).join(b), k);

/** Keys whose STRING VALUE 'memory' is an enum, not someone's words. */
const ENUM_KEYS = new Set(['source', 'kind', 'entityKind', 'targetKind', 'dataKind', 'type']);
/** Where a 'memories/…' string is one of OUR paths (an object, a virtual ref), not a file someone named. */
const PATH_KEYS = new Set([
  'path',
  'storagePath',
  'thumbPath',
  'objectPath',
  'ref',
  'refPath',
  'prefix',
  'src',
]);
/** Free text people wrote: never touched. */
const TEXT_KEYS = new Set([
  'title',
  'name',
  'description',
  'text',
  'body',
  'bodyMd',
  'body_md',
  'markdown',
  'content',
  'message',
  'systemPrompt',
  'summary',
  'note',
  'label',
  'subject',
  'html',
  'value',
]);

function rewriteValue(key: string | null, v: unknown): unknown {
  if (typeof v === 'string') {
    if (key && TEXT_KEYS.has(key)) return v;
    if (v === 'memory' && key && ENUM_KEYS.has(key)) return 'bucket';
    if (v === 'memory:read') return 'bucket:read';
    if (v === 'memory:write') return 'bucket:write';
    if (key && PATH_KEYS.has(key) && v.startsWith('memories/'))
      return 'buckets/' + v.slice('memories/'.length);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => rewriteValue(key, x));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    if (key && TEXT_KEYS.has(key)) return v; // rich text
    const out: Doc = {};
    for (const [k, x] of Object.entries(v)) out[renameKey(k)] = rewriteValue(k, x);
    return out;
  }
  return v; // Timestamps, refs, bytes …
}

/** The document with the rename applied, or null when nothing changes. */
export function renamedDoc(d: Doc): Doc | null {
  const next = rewriteValue(null, d) as Doc;
  return JSON.stringify(sortKeys(next)) === JSON.stringify(sortKeys(d)) ? null : next;
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Doc)[k])]),
    );
  return v;
}

/** Every collection id the app writes (collection-group queries reach every level). */
const COLLECTION_IDS = [
  ...new Set([
    ...Object.values(COLLECTIONS),
    '_tasks',
    '_cron',
    '_config',
    '_env',
    '_dev',
    'items',
    'aggStats',
    'ui',
    'workspaces',
  ]),
  // buckets / nodes are moved whole above; viewers hold an artifact's own data (anyone's JSON).
].filter((c) => !['buckets', 'nodes', 'viewers', 'builds'].includes(c));

// ─── 2. handles ──────────────────────────────────────────────────────────────

async function freeHandle(
  db: Db,
  wanted: string,
  who: { kind: 'user' | 'org'; id: string },
  apply: boolean,
  taken: Set<string>,
): Promise<string> {
  const base = handleFrom(wanted);
  for (let n = 1; n < 1000; n++) {
    const h = n === 1 ? base : `${base.slice(0, 35)}-${n}`;
    if (RESERVED_HANDLES.has(h) || taken.has(h)) continue;
    const cur = (await db.doc(`handles/${h}`).get()).data();
    if (cur && (cur.kind !== who.kind || cur.id !== who.id)) continue;
    taken.add(h);
    if (apply && !cur) await db.doc(`handles/${h}`).set(who);
    return h;
  }
  throw new Error(`no free handle near ${wanted}`);
}

// ─── the run ─────────────────────────────────────────────────────────────────

export async function migrateRestructure(o: RestructureOptions): Promise<RestructureSummary> {
  const { db, bucket, apply } = o;
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now();
  const s: RestructureSummary = {
    bucketsMoved: 0,
    nodesMoved: 0,
    docsRewritten: 0,
    objectsMoved: 0,
    handles: 0,
    owners: 0,
    orgs: 0,
    movedIntoOrgs: 0,
    workspacesRemoved: 0,
    sidebarsRemoved: 0,
  };

  // 1a. memories/{m} and their nodes → buckets/{m}
  const mems = await db.collection('memories').get();
  for (const m of mems.docs) {
    const doc = (renamedDoc(m.data()) ?? m.data()) as Doc;
    const nodes = await db.collection(`memories/${m.id}/nodes`).get();
    log(`bucket ${m.id} "${String(doc.name)}": ${nodes.size} nodes`);
    s.bucketsMoved++;
    s.nodesMoved += nodes.size;
    if (!apply) continue;
    await db.doc(`buckets/${m.id}`).set(doc);
    for (const n of nodes.docs)
      await db.doc(`buckets/${m.id}/nodes/${n.id}`).set(renamedDoc(n.data()) ?? n.data());
    for (const n of nodes.docs) await n.ref.delete();
    await m.ref.delete();
  }

  // 1b. every other document
  for (const id of COLLECTION_IDS) {
    let snap;
    try {
      snap = await db.collectionGroup(id).get();
    } catch (e) {
      log(`  (skip ${id}: ${(e as Error).message})`);
      continue;
    }
    for (const d of snap.docs) {
      if (d.ref.path.startsWith('memories/')) continue;
      const next = renamedDoc(d.data());
      if (!next) continue;
      s.docsRewritten++;
      if (s.docsRewritten <= 20) log(`  rename in ${d.ref.path}`);
      if (apply) await d.ref.set(next);
    }
  }

  // 1c. Storage: memories/… → buckets/…
  if (bucket) {
    const [files] = await bucket.getFiles({ prefix: 'memories/' });
    for (const f of files) {
      s.objectsMoved++;
      if (!apply) continue;
      await f.copy(bucket.file('buckets/' + String(f.name).slice('memories/'.length)));
      await f.delete();
    }
    log(`storage: ${files.length} objects under memories/`);
  }

  // 2a. handles for every person
  const taken = new Set<string>();
  const users = await db.collection('users').get();
  const handleOf = new Map<string, string>();
  for (const u of users.docs) {
    const d = u.data() as { handle?: string; name?: string; email?: string; deletedAt?: unknown };
    if (d.handle) {
      handleOf.set(u.id, d.handle);
      taken.add(d.handle);
      continue;
    }
    if (d.deletedAt) continue;
    const h = await freeHandle(
      db,
      d.email || d.name || u.id,
      { kind: 'user', id: u.id },
      apply,
      taken,
    );
    handleOf.set(u.id, h);
    s.handles++;
    log(`handle @${h} for ${d.email ?? u.id}`);
    if (apply) await u.ref.set({ handle: h }, { merge: true });
  }
  const userOwner = (uid: string): { owner: OwnerRef; ownerKey: string; ownerHandle: string } => {
    const owner: OwnerRef = { kind: 'user', id: uid };
    return { owner, ownerKey: ownerKeyOf(owner), ownerHandle: handleOf.get(uid) ?? uid };
  };

  // 2b. owners (and slugs) for every board, artifact, bucket
  const slugsTaken = new Map<string, Set<string>>();
  const slugFor = (ownerKey: string, kind: string, name: string) => {
    const set = slugsTaken.get(`${ownerKey}/${kind}`) ?? new Set<string>();
    slugsTaken.set(`${ownerKey}/${kind}`, set);
    const base = slugify(name);
    for (let n = 1; ; n++) {
      const sl = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
      if (!set.has(sl)) {
        set.add(sl);
        return sl;
      }
    }
  };
  const boards = await db.collection('boards').get();
  for (const b of boards.docs) {
    const d = b.data() as { owner?: OwnerRef; createdBy: string; access: Record<string, string> };
    if (d.owner) continue;
    const admins = Object.entries(d.access ?? {})
      .filter(([u, r]) => r === 'admin' && !u.startsWith('ag_'))
      .map(([u]) => u);
    const uid = admins.includes(d.createdBy) ? d.createdBy : (admins[0] ?? d.createdBy);
    s.owners++;
    if (apply) await b.ref.update(userOwner(uid));
  }
  for (const col of ['artifacts', 'buckets'] as const) {
    const all = await db.collection(col).get();
    for (const t of all.docs) {
      const d = t.data() as { ownerKey?: string; slug?: string; name: string };
      if (d.ownerKey && d.slug)
        slugsTaken.set(
          `${d.ownerKey}/${col}`,
          (slugsTaken.get(`${d.ownerKey}/${col}`) ?? new Set()).add(d.slug),
        );
    }
    for (const t of all.docs) {
      const d = t.data() as { owner?: OwnerRef; ownerUid: string; name: string; slug?: string };
      if (d.owner && d.slug) continue;
      const own = userOwner(d.ownerUid);
      s.owners++;
      if (apply) await t.ref.update({ ...own, slug: d.slug ?? slugFor(own.ownerKey, col, d.name) });
    }
  }

  // 3. workspaces → orgs
  for (const u of users.docs) {
    const wss = await db.collection(`users/${u.id}/workspaces`).get();
    for (const w of wss.docs) {
      const d = w.data() as {
        name: string;
        indicator?: unknown;
        description?: string;
        boardIds?: string[];
        artifactIds?: string[];
        bucketIds?: string[];
        memoryIds?: string[];
      };
      const orgId = `ws${w.id}`.slice(0, 40);
      const existing = (await db.doc(`orgs/${orgId}`).get()).data() as Org | undefined;
      const handle =
        existing?.handle ??
        (await freeHandle(db, d.name, { kind: 'org', id: orgId }, apply, taken));
      if (!existing) {
        s.orgs++;
        log(`org @${handle} from ${handleOf.get(u.id) ?? u.id}'s workspace "${d.name}"`);
        const org: Org = {
          handle,
          name: d.name.slice(0, 80),
          ...(d.description ? { description: d.description } : {}),
          ...(d.indicator ? { indicator: d.indicator as Org['indicator'] } : {}),
          members: { [u.id]: 'owner' },
          memberUids: [u.id],
          baseRole: 'editor',
          createdBy: u.id,
          createdAt: now,
          updatedAt: now,
        };
        if (apply) await db.doc(`orgs/${orgId}`).set(org);
      }
      const owner: OwnerRef = { kind: 'org', id: orgId };
      const into = { owner, ownerKey: ownerKeyOf(owner), ownerHandle: handle };
      const moveIn = async (col: 'boards' | 'artifacts' | 'buckets', id: string) => {
        const ref = db.doc(`${col}/${id}`);
        const t = (await ref.get()).data() as
          | { ownerKey?: string; access: Record<string, string>; ownerUid?: string; name: string }
          | undefined;
        if (!t) return;
        // Only what this person owns, and only once (the first workspace wins).
        const mine = col === 'boards' ? t.access?.[u.id] === 'admin' : t.ownerUid === u.id;
        const personal = !t.ownerKey || t.ownerKey === `user:${u.id}`;
        if (!mine || !personal || t.ownerKey === into.ownerKey) return;
        s.movedIntoOrgs++;
        if (!apply) return;
        await ref.update({
          ...into,
          ...(col === 'boards' ? {} : { slug: slugFor(into.ownerKey, col, t.name) }),
        });
      };
      for (const id of d.boardIds ?? []) await moveIn('boards', id);
      for (const id of d.artifactIds ?? []) await moveIn('artifacts', id);
      for (const id of [...(d.bucketIds ?? []), ...(d.memoryIds ?? [])])
        await moveIn('buckets', id);
      s.workspacesRemoved++;
      if (apply) await w.ref.delete();
    }
  }

  // 4. no more hiding
  for (const u of users.docs) {
    const side = db.doc(`users/${u.id}/ui/sidebar`);
    if (!(await side.get()).exists) continue;
    s.sidebarsRemoved++;
    if (apply) await side.delete();
  }

  log(`summary ${JSON.stringify(s)}`);
  return s;
}
