/**
 * ORGS (agents.html §AC) in the app: mine, live (orgs where I am a member),
 * and the helpers that place a board / artifact / bucket under its owner.
 * Written only through the org commands.
 */
import type { Readable } from 'svelte/store';
import { paths, type Org, type OwnerRef } from '@tm/shared';
import { docStore, queryStore, type DocState, type QueryState, type WithId } from '$lib/stores';

/** Unsorted (sort by name where shown: an orderBy here would need a composite index). */
export function myOrgs(uid: string | null | undefined): Readable<QueryState<Org>> {
  return queryStore<Org>(
    uid ? { path: paths.orgs(), where: [['memberUids', 'array-contains', uid]] } : null,
  );
}

export function orgDoc(orgId: string | null | undefined): Readable<DocState<Org>> {
  return docStore<Org>(orgId ? paths.org(orgId) : null);
}

/** 'org:{id}' / 'user:{uid}' of a thing (things from before §AC: their creator's). */
export function ownerKeyOfThing(t: {
  ownerKey?: string | null;
  ownerUid?: string;
  createdBy?: string;
}): string {
  return t.ownerKey ?? `user:${t.ownerUid ?? t.createdBy ?? ''}`;
}

/** Owned by one of these orgs? (Then it lives under the org in the sidebar, not in the root lists.) */
export function inOrgs(t: { ownerKey?: string | null }, orgs: readonly WithId<Org>[]): boolean {
  return !!t.ownerKey && orgs.some((o) => t.ownerKey === `org:${o.id}`);
}

export type { OwnerRef };

/** 'org:{id}' / 'user:{uid}' (OwnerSelect) → the commands' `owner`; undefined = me. */
export function ownerOf(v: string | null | undefined): OwnerRef | undefined {
  const [kind, id] = (v ?? '').split(':');
  return (kind === 'org' || kind === 'user') && id ? { kind, id } : undefined;
}
