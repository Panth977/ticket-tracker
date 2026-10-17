/**
 * EVERYTHING UNDER ITS OWNER (agents.html §AC, like GitHub): the sidebar has
 * no root lists of boards, artifacts, buckets and dictionaries — each lives under the
 * person or org that owns it. This groups what I can open by owner:
 *
 *   orgs   every org I am in (even an empty one), then any other org that
 *          owns something shared with me directly
 *   users  me first (always, even with nothing yet), then every person who
 *          owns something shared with me
 *
 * `canCreate` says where the + goes: my own space, and orgs I am an owner or
 * admin of. Pure, so it is tested without a browser.
 */
import type { Org, OrgRole } from '@tm/shared';
import { ownerKeyOfThing } from './store';

export interface Owned {
  id: string;
  name: string;
  ownerKey?: string | null;
  ownerHandle?: string;
  ownerUid?: string;
  createdBy?: string;
}

export interface OwnerGroup<B, A, M, D = Owned> {
  /** 'org:{id}' / 'user:{uid}' */
  key: string;
  kind: 'org' | 'user';
  id: string;
  /** null until known (a person or org seen only through a thing that names no handle). */
  handle: string | null;
  /** An org's name; null for a person (drawn with PersonName) or an org I am not in. */
  name: string | null;
  org: (Org & { id: string }) | null;
  /** My role in this org; null for people and for orgs I am not in. */
  myRole: OrgRole | null;
  me: boolean;
  canCreate: boolean;
  boards: B[];
  artifacts: A[];
  buckets: M[];
  dictionaries: D[];
}

export function ownerGroups<
  B extends Owned,
  A extends Owned,
  M extends Owned,
  D extends Owned = Owned,
>(input: {
  me: string;
  myHandle: string | null | undefined;
  orgs: readonly (Org & { id: string })[];
  boards: readonly B[];
  artifacts: readonly A[];
  buckets: readonly M[];
  dictionaries?: readonly D[];
}): { orgs: OwnerGroup<B, A, M, D>[]; users: OwnerGroup<B, A, M, D>[] } {
  const groups = new Map<string, OwnerGroup<B, A, M, D>>();
  const group = (key: string): OwnerGroup<B, A, M, D> => {
    let g = groups.get(key);
    if (!g) {
      const [kind, id] = key.split(':') as ['org' | 'user', string];
      g = {
        key,
        kind,
        id,
        handle: null,
        name: null,
        org: null,
        myRole: null,
        me: kind === 'user' && id === input.me,
        canCreate: kind === 'user' && id === input.me,
        boards: [],
        artifacts: [],
        buckets: [],
        dictionaries: [],
      };
      groups.set(key, g);
    }
    return g;
  };

  group(`user:${input.me}`).handle = input.myHandle ?? null;
  for (const o of input.orgs) {
    const g = group(`org:${o.id}`);
    const role = o.members[input.me] ?? null;
    Object.assign(g, {
      handle: o.handle,
      name: o.name,
      org: o,
      myRole: role,
      canCreate: role === 'owner' || role === 'admin',
    });
  }
  const place = <T extends Owned>(list: readonly T[], pick: (g: OwnerGroup<B, A, M, D>) => T[]) => {
    for (const t of list) {
      const g = group(ownerKeyOfThing(t));
      g.handle ??= t.ownerHandle ?? null;
      pick(g).push(t);
    }
  };
  place(input.boards, (g) => g.boards as unknown as B[]);
  place(input.artifacts, (g) => g.artifacts as unknown as A[]);
  place(input.buckets, (g) => g.buckets as unknown as M[]);
  place(input.dictionaries ?? [], (g) => g.dictionaries as unknown as D[]);

  const byName = (a: OwnerGroup<B, A, M, D>, b: OwnerGroup<B, A, M, D>) =>
    (a.name ?? a.handle ?? a.id).localeCompare(b.name ?? b.handle ?? b.id);
  const all = [...groups.values()];
  return {
    // Orgs I am in first, then the ones I only reach a thing of.
    orgs: all
      .filter((g) => g.kind === 'org')
      .sort((a, b) => Number(!!b.myRole) - Number(!!a.myRole) || byName(a, b)),
    users: all
      .filter((g) => g.kind === 'user')
      .sort((a, b) => Number(b.me) - Number(a.me) || byName(a, b)),
  };
}
