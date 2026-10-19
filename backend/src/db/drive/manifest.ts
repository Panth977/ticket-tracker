/**
 * `<entity folder>/.tm-entity.json` (docs/plan/bucket.html §L7) — what another
 * TaskManager needs to import the folder: what it is, its name (and a board's
 * key), and its people by e-mail (uids mean nothing to another instance).
 *
 * The workspace index — who may see it — stays in the database; this file
 * is its portable description, rewritten after the entity's document changes.
 */
import type { Db } from '../types.js';
import { driveOf, type DriveEntity } from './board.js';
import { writeDocFile } from './docfiles.js';

export const MANIFEST_FILE = '.tm-entity';
export const MANIFEST_SCHEMA = 'tm/entity@1';

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  kind: string;
  id: string;
  name: string;
  key?: string;
  description?: string | null;
  indicator?: unknown;
  owner: string | null;
  people: { email: string; role: string }[];
  writtenAt: string;
}

const last = new Map<string, number>();

export async function buildManifest(base: Db, e: DriveEntity): Promise<Manifest | null> {
  const snap = await base.doc(`${e.kind}/${e.id}`).get();
  if (!snap.exists) return null;
  const d = snap.data() as Record<string, unknown>;
  const access = (d.access ?? {}) as Record<string, string>;
  const uids = Object.keys(access).filter((u) => !u.startsWith('ag_'));
  const ownerUid = (d.ownerUid ?? d.createdBy ?? null) as string | null;
  const all = [...new Set([...uids, ...(ownerUid ? [ownerUid] : [])])];
  const users = all.length ? await base.getAll(...all.map((u) => base.doc(`users/${u}`))) : [];
  const email = new Map(users.map((s) => [s.id, (s.data()?.email as string | undefined) ?? null]));
  return {
    schema: MANIFEST_SCHEMA,
    kind: e.kind,
    id: e.id,
    name: String(d.name ?? ''),
    ...(typeof d.key === 'string' ? { key: d.key } : {}),
    description: (d.description as string | null | undefined) ?? null,
    indicator: d.indicator ?? null,
    owner: ownerUid ? (email.get(ownerUid) ?? null) : null,
    people: uids
      .map((u) => ({ email: email.get(u) ?? '', role: access[u]! }))
      .filter((p) => p.email),
    writtenAt: new Date().toISOString(),
  };
}

/** Rewrite the manifest (best effort, at most every 2 s per entity). */
export async function refreshManifest(base: Db, e: DriveEntity): Promise<void> {
  const key = `${e.kind}/${e.id}`;
  if (Date.now() - (last.get(key) ?? 0) < 2_000) return;
  last.set(key, Date.now());
  try {
    const m = await buildManifest(base, e);
    if (m) await writeDocFile(await driveOf(e), e.folderId, [MANIFEST_FILE], m as never, null);
  } catch (err) {
    console.warn(`[drive] manifest ${key} not written`, err);
  }
}
