/**
 * OWNERS AND ORGS on the server (shared/src/org, agents.html §AC):
 *
 *   handles      claim / release a handle (users and orgs, one namespace)
 *   slugs        an artifact's / bucket's URL name, unique per owner
 *   org roles    who is what in an org; the checks every org command makes
 *   FAN-OUT      syncThing(): make a thing's access say what its owner org
 *                gives — members added at orgRoleOn*(), what the org gave
 *                and no longer gives taken away, a role given directly (or
 *                a higher one) left alone. Recorded in thing.orgGranted.
 *
 * The fan-out writes the same documents an invite acceptance or a removal
 * writes (access + its derived lists, board members/{uid}, the RTDB
 * mirrors), so nothing that reads access needs to know orgs exist.
 */
import {
  errors,
  handleFrom,
  isAgentId,
  orgRoleOnBoard,
  orgRoleOnItem,
  ownerKeyOf,
  paths,
  slugify,
  type BoardRole,
  type HandleDoc,
  type Org,
  type OrgRole,
  type OwnerRef,
  type ThingKind,
  type Uid,
} from '@tm/shared';
import {
  artifactRef,
  syncArtifactMirror,
  withMembers as artifactMembers,
} from '../artifacts/shared.js';
import { bucketRef, withMembers as bucketMembers } from '../bucket/shared.js';
import {
  boardRef,
  deriveAccess,
  memberDoc,
  memberRef,
  profileOf,
  syncReaders,
} from '../commands/boardShared.js';
import { db } from '../db/index.js';
import type { ServerCtx } from '../runtime/context.js';
import { provideOrgEnvTarget } from '../env/shared.js';
import { runTx, type Tx } from '../runtime/tx.js';

export const orgRef = (orgId: string) => db().doc(paths.org(orgId));
export const handleRef = (handle: string) => db().doc(paths.handle(handle));

// ─── orgs ────────────────────────────────────────────────────────────────────

export async function loadOrg(orgId: string, tx?: Tx): Promise<Org & { id: string }> {
  const snap = tx ? await tx.get(orgRef(orgId)) : await orgRef(orgId).get();
  if (!snap.exists) throw errors.not_found('No such org');
  return { ...(snap.data() as Org), id: orgId };
}

export const orgRoleOf = (org: Pick<Org, 'members'>, uid: string): OrgRole | null =>
  Object.prototype.hasOwnProperty.call(org.members, uid) ? org.members[uid]! : null;

/** 403 unless the caller (a person) is at least `min` in the org; 404 for strangers. */
export function requireOrgRole(org: Pick<Org, 'members'>, ctx: ServerCtx, min: OrgRole): OrgRole {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Orgs are run by people, not agents');
  const role = orgRoleOf(org, ctx.actor);
  if (!role) throw errors.not_found('No such org');
  const rank = { member: 0, admin: 1, owner: 2 } as const;
  if (rank[role] < rank[min])
    throw errors.forbidden(
      min === 'owner'
        ? 'Only the org’s owners can do this'
        : 'Only the org’s owners and admins can do this',
    );
  return role;
}

export const orgMembers = (members: Record<Uid, OrgRole>) => ({
  members,
  memberUids: Object.keys(members).sort(),
});

// ─── handles ─────────────────────────────────────────────────────────────────

/** Claim `handle` for an owner inside a transaction (409 when taken by someone else). */
export async function claimHandle(tx: Tx, handle: string, who: HandleDoc): Promise<void> {
  const ref = handleRef(handle);
  const cur = (await tx.get(ref)).data() as HandleDoc | undefined;
  if (cur && (cur.kind !== who.kind || cur.id !== who.id))
    throw errors.conflict(`The name “${handle}” is taken`, { field: 'handle' });
  if (!cur) tx.set(ref, who);
}

/** A free handle near `wanted` ('panth', 'panth-2', …), claimed for `who`. Outside any transaction. */
export async function claimFreeHandle(wanted: string, who: HandleDoc): Promise<string> {
  const base = handleFrom(wanted);
  for (let n = 1; n < 1000; n++) {
    const h = n === 1 ? base : `${base.slice(0, 35)}-${n}`;
    try {
      await runTx((tx) => claimHandle(tx, h, who));
      return h;
    } catch (e) {
      if ((e as { code?: string }).code !== 'conflict') throw e;
    }
  }
  throw errors.conflict('No free name');
}

/** The handle of an owner (users/{uid}.handle, orgs/{id}.handle). */
export async function handleOf(owner: OwnerRef): Promise<string> {
  const snap = await db()
    .doc(owner.kind === 'org' ? paths.org(owner.id) : paths.user(owner.id))
    .get();
  return ((snap.data() as { handle?: string } | undefined)?.handle ?? owner.id).toString();
}

/** A person's handle, made on first need (accounts from before §AC, sign-ups). */
export async function ensureUserHandle(uid: Uid): Promise<string> {
  const ref = db().doc(paths.user(uid));
  const u = (await ref.get()).data() as
    { handle?: string; name?: string; email?: string } | undefined;
  if (u?.handle) return u.handle;
  const h = await claimFreeHandle(u?.email || u?.name || uid, { kind: 'user', id: uid });
  await ref.set({ handle: h }, { merge: true });
  return h;
}

// ─── slugs ───────────────────────────────────────────────────────────────────

/** A slug for `name` unique among the owner's things of this kind ('dash', 'dash-2', …). */
export async function freeSlug(
  kind: 'artifact' | 'bucket',
  owner: OwnerRef,
  name: string,
  exceptId?: string,
): Promise<string> {
  const col = db().collection(kind === 'artifact' ? 'artifacts' : 'buckets');
  const base = slugify(name);
  for (let n = 1; n < 1000; n++) {
    const s = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
    const hit = await col
      .where('ownerKey', '==', ownerKeyOf(owner))
      .where('slug', '==', s)
      .limit(2)
      .get();
    if (hit.docs.every((d) => d.id === exceptId)) return s;
  }
  throw errors.conflict('No free name');
}

// ─── the fan-out ─────────────────────────────────────────────────────────────

const BOARD_RANK: Record<string, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };
const ITEM_RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

/**
 * One person's role on a thing, given what it holds now, what the org gave
 * before (`given`) and what the org gives now (`want`). Returns the new role
 * (null = none) and the new orgGranted entry (null = none).
 */
export function reconcile(
  cur: string | undefined,
  given: string | undefined,
  want: string | null,
  rank: Record<string, number>,
): { role: string | null; granted: string | null } {
  const fromOrg = given !== undefined && cur === given;
  if (given !== undefined && cur !== undefined && cur !== given) {
    // Changed by hand since the org gave it: it is a direct role now. Raise it if the org gives more.
    if (want && rank[want]! > rank[cur]!) return { role: want, granted: want };
    return { role: cur, granted: null };
  }
  if (!want) return { role: fromOrg || cur === undefined ? null : cur, granted: null };
  if (cur === undefined || fromOrg) return { role: want, granted: want };
  // A direct role: the higher of the two.
  return rank[want]! > rank[cur]! ? { role: want, granted: want } : { role: cur, granted: null };
}

/**
 * Make one thing's access match its owner org (`org` null = owned by a
 * person: everything the org once gave is taken back). Idempotent.
 */
export async function syncThing(
  kind: ThingKind,
  id: string,
  org: (Org & { id: string }) | null,
): Promise<void> {
  const now = Date.now();
  if (kind === 'board') {
    const added: Uid[] = [];
    const res = await runTx(async (tx) => {
      const b = (await tx.get(boardRef(id))).data();
      if (!b) return null;
      const granted: Record<string, string> = {
        ...((b as { orgGranted?: Record<string, string> }).orgGranted ?? {}),
      };
      const access: Record<Uid, BoardRole> = { ...b.access };
      const uids = new Set([...Object.keys(granted), ...(org ? org.memberUids : [])]);
      let changed = false;
      const removed: Uid[] = [];
      for (const uid of uids) {
        const want =
          org && org.members[uid] ? orgRoleOnBoard(org.members[uid]!, org.baseRole) : null;
        const r = reconcile(access[uid], granted[uid], want, BOARD_RANK);
        if ((r.role ?? undefined) !== access[uid]) {
          changed = true;
          if (r.role) {
            if (access[uid] === undefined) added.push(uid);
            access[uid] = r.role as BoardRole;
          } else {
            delete access[uid];
            removed.push(uid);
          }
        }
        if ((r.granted ?? undefined) !== granted[uid]) {
          changed = true;
          if (r.granted) granted[uid] = r.granted;
          else delete granted[uid];
        }
      }
      if (!changed) return null;
      tx.update(boardRef(id), { access, ...deriveAccess(access), orgGranted: granted });
      for (const uid of removed) tx.delete(memberRef(id, uid));
      for (const uid of Object.keys(access))
        if (!added.includes(uid) && access[uid] !== b.access[uid])
          tx.update(memberRef(id, uid), { role: access[uid] });
      return { readerUids: deriveAccess(access).readerUids, access };
    });
    if (!res) return;
    // members/{uid} for the newcomers (outside the transaction: a profile read each).
    for (const uid of added) {
      const p = await profileOf(uid);
      await memberRef(id, uid).set(memberDoc(uid, res.access[uid]!, p, null, now));
    }
    await syncReaders(id, res.readerUids);
    return;
  }
  const ref = db().doc(`${kind === 'artifact' ? 'artifacts' : 'buckets'}/${id}`);
  const next = await runTx(async (tx) => {
    const t = (await tx.get(ref)).data() as
      | { access: Record<Uid, string>; ownerUid: Uid; orgGranted?: Record<string, string> }
      | undefined;
    if (!t) return null;
    const granted = { ...(t.orgGranted ?? {}) };
    const access = { ...t.access };
    const uids = new Set([...Object.keys(granted), ...(org ? org.memberUids : [])]);
    let changed = false;
    for (const uid of uids) {
      if (uid === t.ownerUid) continue; // the owner's own role is never the org's to change
      const want = org && org.members[uid] ? orgRoleOnItem(org.members[uid]!, org.baseRole) : null;
      const r = reconcile(access[uid], granted[uid], want, ITEM_RANK);
      if ((r.role ?? undefined) !== access[uid]) {
        changed = true;
        if (r.role) access[uid] = r.role;
        else delete access[uid];
      }
      if ((r.granted ?? undefined) !== granted[uid]) {
        changed = true;
        if (r.granted) granted[uid] = r.granted;
        else delete granted[uid];
      }
    }
    if (!changed) return null;
    const members =
      kind === 'artifact'
        ? artifactMembers(access as Parameters<typeof artifactMembers>[0])
        : bucketMembers(access as Parameters<typeof bucketMembers>[0]);
    tx.update(ref as never, { ...members, orgGranted: granted, updatedAt: now } as never);
    return { ...t, ...members };
  });
  if (next && kind === 'artifact')
    await syncArtifactMirror(id, next as unknown as Parameters<typeof syncArtifactMirror>[1]);
}

/** Every thing an org owns: [kind, id]. */
export async function thingsOf(owner: OwnerRef): Promise<[ThingKind, string][]> {
  const key = ownerKeyOf(owner);
  const [boards, artifacts, buckets] = await Promise.all(
    (['boards', 'artifacts', 'buckets'] as const).map((c) =>
      db().collection(c).where('ownerKey', '==', key).get(),
    ),
  );
  return [
    ...boards!.docs.map((d) => ['board', d.id] as [ThingKind, string]),
    ...artifacts!.docs.map((d) => ['artifact', d.id] as [ThingKind, string]),
    ...buckets!.docs.map((d) => ['bucket', d.id] as [ThingKind, string]),
  ];
}

/** Re-apply an org to everything it owns (after a member or the base role changed). */
export async function syncOrg(orgId: string): Promise<void> {
  const org = await loadOrg(orgId).catch(() => null);
  const things = await thingsOf({ kind: 'org', id: orgId });
  for (const [kind, id] of things) await syncThing(kind, id, org);
}

/**
 * The owner a new thing gets: `wanted` (an org the creator belongs to), else
 * the creator. Returns what to write on it, and the org to fan out.
 */
export async function ownerForCreate(
  creator: Uid,
  wanted: OwnerRef | undefined,
): Promise<{
  fields: { owner: OwnerRef; ownerKey: string; ownerHandle: string };
  org: (Org & { id: string }) | null;
}> {
  if (!wanted || (wanted.kind === 'user' && wanted.id === creator)) {
    const owner: OwnerRef = { kind: 'user', id: creator };
    return {
      fields: { owner, ownerKey: ownerKeyOf(owner), ownerHandle: await ensureUserHandle(creator) },
      org: null,
    };
  }
  if (wanted.kind === 'user')
    throw errors.forbidden('You can only create things for yourself or an org');
  const org = await loadOrg(wanted.id);
  if (!orgRoleOf(org, creator)) throw errors.not_found('No such org');
  return { fields: { owner: wanted, ownerKey: ownerKeyOf(wanted), ownerHandle: org.handle }, org };
}

export const ownerKeyOfThing = ownerKeyOf;

// An org's env (shared/src/env): its members read it, its owners and admins write it.
provideOrgEnvTarget(async (ctx, id, op) => {
  const org = await loadOrg(id);
  if (op === 'write') requireOrgRole(org, ctx, 'admin');
  else if (!orgRoleOf(org, ctx.actor)) throw errors.not_found('No such org');
  return { id, orgId: null };
});

/** An owner's handle changed: every thing it owns carries the new one. */
export async function restampHandle(owner: OwnerRef, handle: string): Promise<void> {
  const things = await thingsOf(owner);
  for (const [kind, id] of things) {
    const col = kind === 'board' ? 'boards' : kind === 'artifact' ? 'artifacts' : 'buckets';
    await db().doc(`${col}/${id}`).update({ ownerHandle: handle });
  }
}
