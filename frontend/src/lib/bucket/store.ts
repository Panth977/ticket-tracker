/**
 * BUCKET as the app reads it (docs/plan/bucket.html §F): live Firestore
 * listeners (shared and ref-counted like every store in $lib/stores) and the
 * pure helpers the sidebar, the list page, ⌘K and settings sort with.
 *
 * Reads are direct for the bucket's own people (the rules let anyone in
 * `access` read the document and its nodes); every WRITE is a command.
 */
import { readable, type Readable } from 'svelte/store';
import {
  bucketCan,
  bucketReach,
  bucketRefPath,
  paths,
  type Bucket,
  type BucketReach,
  type BucketRole,
  type BucketNode,
} from '@tm/shared';
import { docStore, queryStore, type DocState, type QueryState, type WithId } from '$lib/stores';
import { command } from '$lib/api';
import { onBucketChanged } from './changes';

/** Every bucket I have a role on (archived included — see splitBuckets). */
export function myBuckets(uid: string | null | undefined): Readable<QueryState<Bucket>> {
  return queryStore<Bucket>(
    uid ? { path: paths.buckets(), where: [['memberUids', 'array-contains', uid]] } : null,
  );
}

/** One bucket, live. permission-denied means "not shared with me" (or no longer). */
export function bucketDoc(id: string | null | undefined): Readable<DocState<Bucket>> {
  return docStore<Bucket>(id ? paths.bucket(id) : null);
}

/**
 * Every node of one bucket — the tree is built client-side (D-M1: ≤ 10,000,
 * small rows). A managed bucket is a live Firestore query; a DRIVE bucket
 * (§K2) has no nodes in Firestore — Drive is the truth — so its tree is read
 * with bucketTree: on open, after each of my writes, when the tab comes back,
 * and every DRIVE_POLL_MS while it is in front (changes made in Drive itself,
 * or by someone else).
 */
export function bucketNodes(
  id: string | null | undefined,
  storage: 'managed' | 'drive' = 'managed',
): Readable<QueryState<BucketNode>> {
  if (storage === 'drive') return driveNodes(id);
  return queryStore<BucketNode>(id ? { path: paths.bucketNodes(id) } : null);
}

export const DRIVE_POLL_MS = 20_000;

const driveStores = new Map<string, Readable<QueryState<BucketNode>>>();

function driveNodes(id: string | null | undefined): Readable<QueryState<BucketNode>> {
  const empty: QueryState<BucketNode> = { loading: false, error: null, data: [], fromCache: false };
  if (!id) return readable(empty);
  const hit = driveStores.get(id);
  if (hit) return hit;
  const store = readable<QueryState<BucketNode>>({ ...empty, loading: true }, (set) => {
    let last: QueryState<BucketNode> = { ...empty, loading: true };
    let inFlight = false;
    let again = false;
    async function load() {
      if (inFlight) return void (again = true);
      inFlight = true;
      try {
        const r = await command('bucketTree', { bucketId: id! }, { toast: false });
        last = {
          loading: false,
          error: null,
          fromCache: false,
          data: r.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            parentId: n.parentId,
            name: n.name,
            path: n.path,
            // The API never shows where the bytes are: the app reads a Drive file
            // through its reference, which the file door resolves (§E, §K3).
            file: n.file ? { ...n.file, storagePath: bucketRefPath(id!, n.id) } : null,
            createdAt: n.updatedAt,
            createdBy: '',
            updatedAt: n.updatedAt,
            updatedBy: '',
          })),
        };
      } catch (e) {
        last = { ...last, loading: false, error: e as Error };
      } finally {
        inFlight = false;
      }
      set(last);
      if (again) {
        again = false;
        void load();
      }
    }
    void load();
    const off = onBucketChanged((b) => b === id && void load());
    const tick = setInterval(
      () => document.visibilityState === 'visible' && void load(),
      DRIVE_POLL_MS,
    );
    const vis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', vis);
    return () => {
      off();
      clearInterval(tick);
      document.removeEventListener('visibilitychange', vis);
      driveStores.delete(id);
    };
  });
  driveStores.set(id, store);
  return store;
}

// ── pure ─────────────────────────────────────────────────────────────────────

export function bucketRoleIn(
  m: Pick<Bucket, 'access'> | null | undefined,
  uid: string | null | undefined,
): BucketRole | null {
  return (uid && m?.access?.[uid]) || null;
}

/** What I may do here as a direct member (board grants are reached through the API, §D). */
export function myReach(
  m: (Pick<Bucket, 'access' | 'boards' | 'archivedAt'> & { deletingAt?: number | null }) | null,
  uid: string | null | undefined,
): BucketReach {
  return m ? bucketReach(m, { uid }) : null;
}

export const canWrite = (r: BucketReach): boolean => bucketCan.write(r);
export const canManage = (r: BucketReach): boolean => bucketCan.manage(r);

export function splitBuckets<T extends Pick<Bucket, 'name' | 'archivedAt'>>(
  list: readonly T[],
): { active: T[]; archived: T[] } {
  return {
    active: list.filter((m) => m.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
    archived: list
      .filter((m) => m.archivedAt != null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

export const BUCKET_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', owner: true },
  { id: 'people', label: 'People', owner: true },
  /** bucket.html §K6: where its files live, and moving them. */
  { id: 'storage', label: 'Storage', owner: true },
  /** lib/access: the boards and artifacts that use it. */
  { id: 'subscribers', label: 'Subscribers', owner: false },
] as const;
export type BucketSettingsSection = (typeof BUCKET_SETTINGS_SECTIONS)[number]['id'];

/** The owner sees all; an editor or viewer only Subscribers. */
export function bucketSettingsFor(
  role: BucketRole | null,
): readonly { id: BucketSettingsSection; label: string }[] {
  if (role === 'owner') return BUCKET_SETTINGS_SECTIONS;
  if (role) return BUCKET_SETTINGS_SECTIONS.filter((s) => !s.owner);
  return [];
}

/** People on it: owner, editors, viewers. */
export function bucketAccessRows(m: Pick<Bucket, 'access'>): { uid: string; role: BucketRole }[] {
  const order: Record<BucketRole, number> = { owner: 0, editor: 1, viewer: 2 };
  return Object.entries(m.access)
    .map(([uid, role]) => ({ uid, role }))
    .sort((x, y) => order[x.role] - order[y.role] || x.uid.localeCompare(y.uid));
}

/** A file's mode: rendered, or the text in an editor (bucket.html §F). */
export type FileMode = 'preview' | 'code';

/** The view a person last used — Tree or Folders — remembered per browser. */
export type BucketView = 'tree' | 'folders';
const VIEW_KEY = 'tm.bucket.view';
export function savedBucketView(): BucketView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'folders' ? 'folders' : 'tree';
  } catch {
    return 'tree';
  }
}
export function saveBucketView(v: BucketView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private mode */
  }
}

export type { WithId };
