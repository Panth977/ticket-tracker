/**
 * THE ENV → DICTIONARY MIGRATION (dictionary.html §F, ORCH-9) — once per
 * database, Firebase or VM, over whatever Firestore-shaped `db` it is handed.
 *
 * Every non-empty `_env/{kind}:{id}` becomes one dictionary, owned by the
 * thing's owner, with the same pairs as text entries, granted 'read' where
 * the pairs used to apply:
 *
 *   board     → owned by the board's owner, granted to the board
 *   artifact  → owned by the artifact's owner, granted to the artifact
 *   bucket    → owned by the bucket's owner, granted to nothing (nothing read it)
 *   agent     → owned by the agent's owner, granted to the agent
 *   org       → owned by the org, granted to every board and artifact it owns
 *               (they used to inherit it)
 *
 * The dictionary's id is derived from the env document's, so a second run
 * finds it and plans nothing; the `_env` document is removed once its
 * dictionary exists. DRY RUN unless `apply`.
 */
import { createHash } from 'node:crypto';
import {
  COLLECTIONS,
  DICTIONARY_DEFAULT_INDICATOR,
  orgRoleOnItem,
  ownerKeyOf,
  slugify,
  type Dictionary,
  type Org,
  type OwnerRef,
} from '@tm/shared';

/* eslint-disable @typescript-eslint/no-explicit-any -- the handed-in client is Firestore-shaped, not typed here */
type Db = any;
type Doc = Record<string, any>;

export interface DictionaryMigrationOptions {
  db: Db;
  apply: boolean;
  log?: (m: string) => void;
  now?: number;
}

export interface DictionaryMigrationSummary {
  envs: number;
  empty: number;
  created: number;
  existing: number;
  orphans: number;
  removed: number;
}

const KIND_COL: Record<string, string> = {
  board: 'boards',
  artifact: 'artifacts',
  bucket: 'buckets',
  agent: 'agents',
  org: 'orgs',
};

/** The dictionary id an env document becomes: stable, so the migration is idempotent. */
export const envDictionaryId = (envDocId: string): string =>
  `env_${createHash('sha256').update(envDocId).digest('hex').slice(0, 24)}`;

export async function migrateEnvToDictionaries(
  o: DictionaryMigrationOptions,
): Promise<DictionaryMigrationSummary> {
  const db = o.db;
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now();
  const s: DictionaryMigrationSummary = {
    envs: 0,
    empty: 0,
    created: 0,
    existing: 0,
    orphans: 0,
    removed: 0,
  };
  const get = async (path: string): Promise<Doc | null> => {
    const snap = await db.doc(path).get();
    return snap.exists ? (snap.data() as Doc) : null;
  };
  const orgs = new Map<string, (Org & { id: string }) | null>();
  const orgOf = async (id: string) => {
    if (!orgs.has(id)) {
      const d = await get(`orgs/${id}`);
      orgs.set(id, d ? ({ ...(d as Org), id } as Org & { id: string }) : null);
    }
    return orgs.get(id)!;
  };
  const handleOf = async (owner: OwnerRef): Promise<string> => {
    if (owner.kind === 'org') return (await orgOf(owner.id))?.handle ?? owner.id;
    return ((await get(`users/${owner.id}`))?.handle as string | undefined) ?? owner.id;
  };
  const slugs = new Map<string, Set<string>>();
  const freeSlug = async (owner: OwnerRef, name: string): Promise<string> => {
    const key = ownerKeyOf(owner);
    if (!slugs.has(key)) {
      const snap = await db.collection(COLLECTIONS.dictionaries).where('ownerKey', '==', key).get();
      slugs.set(key, new Set(snap.docs.map((d: Doc) => d.data().slug as string)));
    }
    const taken = slugs.get(key)!;
    const base = slugify(name);
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
      if (!taken.has(slug)) {
        taken.add(slug);
        return slug;
      }
    }
  };

  const envs = await db.collection('_env').get();
  for (const envDoc of envs.docs) {
    s.envs++;
    const docId = envDoc.id as string;
    const [kind, ...rest] = docId.split(':');
    const id = rest.join(':');
    const vars = ((envDoc.data() as Doc).vars ?? {}) as Record<string, string>;
    const pairs = Object.entries(vars);
    const dictId = envDictionaryId(docId);
    const dictPath = `${COLLECTIONS.dictionaries}/${dictId}`;
    const drop = async () => {
      s.removed++;
      if (o.apply) await db.doc(`_env/${docId}`).delete();
    };
    if (!pairs.length) {
      s.empty++;
      log(`${docId}: empty — removed`);
      await drop();
      continue;
    }
    if (await get(dictPath)) {
      s.existing++;
      log(`${docId}: already ${dictId} — removing the env`);
      await drop();
      continue;
    }
    const col = KIND_COL[kind ?? ''];
    const thing = col ? await get(`${col}/${id}`) : null;
    if (!thing) {
      s.orphans++;
      log(`${docId}: its ${kind ?? '?'} is gone — removed with ${pairs.length} pairs`);
      await drop();
      continue;
    }

    // Who owns it, who it is granted to.
    let owner: OwnerRef;
    let ownerUid: string;
    const boards: Record<string, 'read'> = {};
    const artifacts: Record<string, 'read'> = {};
    const agents: Record<string, 'read'> = {};
    if (kind === 'org') {
      owner = { kind: 'org', id };
      const org = await orgOf(id);
      ownerUid =
        Object.entries(org?.members ?? {}).find(([, r]) => r === 'owner')?.[0] ??
        (org?.createdBy as string);
      for (const c of ['boards', 'artifacts'] as const) {
        const snap = await db.collection(c).where('ownerKey', '==', ownerKeyOf(owner)).get();
        for (const d of snap.docs) (c === 'boards' ? boards : artifacts)[d.id] = 'read';
      }
    } else if (kind === 'agent') {
      ownerUid = thing.ownerUid as string;
      owner = { kind: 'user', id: ownerUid };
      agents[id] = 'read';
    } else {
      owner = (thing.owner as OwnerRef | undefined) ?? {
        kind: 'user',
        id: (thing.ownerUid ?? thing.createdBy) as string,
      };
      if (owner.kind === 'user') ownerUid = owner.id;
      else {
        const org = await orgOf(owner.id);
        ownerUid =
          (thing.ownerUid as string | undefined) ??
          Object.entries(org?.members ?? {}).find(([, r]) => r === 'owner')?.[0] ??
          (org?.createdBy as string);
      }
      if (kind === 'board') boards[id] = 'read';
      if (kind === 'artifact') artifacts[id] = 'read';
    }
    if (!ownerUid) {
      s.orphans++;
      log(`${docId}: no owner to give it to — left alone`);
      continue;
    }

    // People: the owner, and (an org's) its members at the role the org gives.
    const access: Record<string, 'owner' | 'editor' | 'viewer'> = { [ownerUid]: 'owner' };
    const orgGranted: Record<string, string> = {};
    if (owner.kind === 'org') {
      const org = await orgOf(owner.id);
      for (const [uid, role] of Object.entries(org?.members ?? {})) {
        if (uid === ownerUid) continue;
        const r = orgRoleOnItem(role, org!.baseRole);
        if (r) {
          access[uid] = r;
          orgGranted[uid] = r;
        }
      }
    }
    const thingName =
      kind === 'org' ? ((await orgOf(id))?.name ?? id) : ((thing.name as string) ?? id);
    const name = `${thingName} env`.slice(0, 80);
    const entries = pairs.map(([k, v]) => ({ k, v: JSON.stringify(v) }));
    const bytes = entries.reduce((n, e) => n + e.k.length + e.v.length, 0);
    const d: Dictionary = {
      name,
      description: `Moved from the ${kind}'s Settings › Env (ORCH-9).`,
      indicator: DICTIONARY_DEFAULT_INDICATOR,
      ownerUid,
      owner,
      ownerKey: ownerKeyOf(owner),
      ownerHandle: await handleOf(owner),
      ...(Object.keys(orgGranted).length ? { orgGranted } : {}),
      slug: await freeSlug(owner, name),
      access,
      memberUids: Object.keys(access).sort(),
      boards,
      artifacts,
      agents,
      boardIds: Object.keys(boards).sort(),
      artifactIds: Object.keys(artifacts).sort(),
      agentIds: Object.keys(agents).sort(),
      stats: { entries: entries.length, bytes },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    s.created++;
    log(
      `${docId}: → ${dictId} "${name}" (${pairs.length} pairs; ${Object.keys(boards).length} boards, ${Object.keys(artifacts).length} artifacts, ${Object.keys(agents).length} agents)`,
    );
    if (o.apply) {
      await db
        .doc(`${dictPath}/content/entries`)
        .set({ entries, updatedAt: now, updatedBy: ownerUid });
      await db.doc(dictPath).set(d);
    }
    await drop();
  }
  return s;
}
