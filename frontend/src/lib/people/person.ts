/**
 * person(id) — how every screen shows a PRINCIPAL: a person or an agent
 * (docs/plan/agents.html §A). Display name + email (or 'Agent' + owner) +
 * picture, live, so a rename shows up everywhere at once. Shared and
 * ref-counted like every live store; avatar download URLs are cached per
 * Storage path.
 *
 *   const p = person(id);   {$p.person?.name} {$p.person?.kind === 'agent'}
 *
 * People come from users/{uid} (any signed-in person may GET one). Agents never
 * sign in and their profile (agents/{id}) is readable by the OWNER only, so an
 * agent is read, best first, from:
 *   1. its members/ row on a board we were told it is on (noteBoardMembers),
 *   2. its own profile — works when it is ours,
 *   3. its members/ row on the first of MY boards whose access map has it.
 * Members rows carry the denormalised name / picture / owner (agentUpdate fans
 * them out), so all three give the same answer.
 */
import { getDownloadURL, ref } from 'firebase/storage';
import { derived, readable, type Readable } from 'svelte/store';
import { isAgentId, paths, type Agent, type Board, type BoardMember, type User } from '@tm/shared';
import { auth } from '$lib/firebase/auth.svelte';
import { getStorageClient } from '$lib/firebase/client';
import { docStore, queryStore, registry } from '$lib/stores/live';
import { agentToPerson, memberToPerson, unknownAgent, type Person } from './principal';

export type { Person } from './principal';

export interface PersonState {
  loading: boolean;
  person: Person | null;
  error: Error | null;
}

const urlCache = new Map<string, Promise<string | null>>();

/** Storage path → download URL (cached; null on failure). */
export function avatarUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  let p = urlCache.get(path);
  if (!p) {
    p = getDownloadURL(ref(getStorageClient(), path)).catch(() => null);
    urlCache.set(path, p);
  }
  return p;
}

const IDLE: PersonState = { loading: false, person: null, error: null };

export function toPerson(
  uid: string,
  u: Pick<User, 'name' | 'email' | 'deletedAt'>,
  url: string | null,
): Person {
  const deleted = u.deletedAt != null;
  return {
    uid,
    kind: 'user',
    name: deleted ? 'Deleted user' : u.name || u.email || 'Unknown',
    email: deleted ? '' : u.email,
    avatarUrl: deleted ? null : url,
    deleted,
  };
}

// ── agent board hints ──
const boardHints = new Map<string, string>();

/**
 * Tell person() which board an agent is on, so it reads that members/ row
 * first. Anything that already holds a board's member list (a board page, a
 * ticket, People & roles) should call this — it is cheap and idempotent.
 */
export function noteBoardMembers(
  boardId: string,
  members: readonly Pick<BoardMember, 'uid'>[],
): void {
  for (const m of members)
    if (isAgentId(m.uid) && !boardHints.has(m.uid)) boardHints.set(m.uid, boardId);
}

interface Source {
  loading: boolean;
  person: Person | null;
}
const DONE_EMPTY: Source = { loading: false, person: null };

/** A live doc mapped to a Person, the avatar URL resolved after the name shows. */
function withAvatar<T>(
  store: Readable<{ loading: boolean; data: T | null }>,
  map: (d: T, url: string | null) => Person,
  pathOf: (d: T) => string | null | undefined,
): Readable<Source> {
  return readable<Source>({ loading: true, person: null }, (set) => {
    let seq = 0;
    return store.subscribe((s) => {
      const mine = ++seq;
      if (s.loading) return;
      if (!s.data) return set(DONE_EMPTY);
      const d = s.data;
      set({ loading: false, person: map(d, null) });
      const path = pathOf(d);
      if (path)
        void avatarUrl(path).then((url) => {
          if (mine === seq && url) set({ loading: false, person: map(d, url) });
        });
    });
  });
}

function memberSource(boardId: string, id: string): Readable<Source> {
  return withAvatar(
    docStore<BoardMember>(paths.member(boardId, id)),
    (m, url) => memberToPerson({ ...m, uid: id }, url),
    (m) => m.avatarPath,
  );
}

function agentDocSource(id: string): Readable<Source> {
  // Not ours → permission-denied → data null: an empty source, not an error.
  return withAvatar(
    docStore<Agent>(paths.agent(id)),
    (a, url) => agentToPerson(id, a, url),
    (a) => (a.archivedAt == null ? a.avatarPath : null),
  );
}

/** The members/ row on the first of my boards that has this agent in its access map. */
function myBoardsSource(me: string, id: string): Readable<Source> {
  return readable<Source>({ loading: true, person: null }, (set) => {
    let boardId: string | null = null;
    let off: (() => void) | null = null;
    const offBoards = queryStore<Board>({
      path: paths.boards(),
      where: [['readerUids', 'array-contains', me]],
    }).subscribe((s) => {
      if (s.loading) return;
      const b = s.data.find((x) => x.access?.[id] != null);
      const next = b?.id ?? null;
      if (next === boardId && off) return;
      boardId = next;
      off?.();
      off = null;
      if (!next) return set(DONE_EMPTY);
      boardHints.set(id, next);
      off = memberSource(next, id).subscribe(set);
    });
    return () => {
      off?.();
      offBoards();
    };
  });
}

function agentPerson(id: string): Readable<PersonState> {
  return registry.get<PersonState>(
    'p:' + id,
    { loading: true, person: null, error: null },
    (set) => {
      const me = auth.uid;
      const hint = boardHints.get(id);
      const sources: Readable<Source>[] = [];
      if (hint) sources.push(memberSource(hint, id));
      sources.push(agentDocSource(id));
      if (me) sources.push(myBoardsSource(me, id));
      return derived(sources, (list) => list).subscribe((list) => {
        // Take the best source that answered; wait only while a BETTER one is still loading.
        for (const s of list) {
          if (s.person) return set({ loading: false, person: s.person, error: null });
          if (s.loading) return set({ loading: true, person: null, error: null });
        }
        set({ loading: false, person: unknownAgent(id), error: null });
      });
    },
  );
}

export function person(uid: string | null | undefined): Readable<PersonState> {
  if (!uid) return readable(IDLE);
  if (isAgentId(uid)) return agentPerson(uid);
  return registry.get<PersonState>(
    'p:' + uid,
    { loading: true, person: null, error: null },
    (set) => {
      let seq = 0;
      return docStore<User>(paths.user(uid)).subscribe((s) => {
        const mine = ++seq;
        if (s.loading) return;
        if (!s.data) {
          set({ loading: false, person: null, error: s.error });
          return;
        }
        const u = s.data;
        set({ loading: false, person: toPerson(uid, u, null), error: null });
        if (u.avatarPath && u.deletedAt == null) {
          void avatarUrl(u.avatarPath).then((url) => {
            if (mine === seq && url)
              set({ loading: false, person: toPerson(uid, u, url), error: null });
          });
        }
      });
    },
  );
}

/** Alias that reads better in principal-aware code. */
export const principal = person;
