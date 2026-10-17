/**
 * DICTIONARY (docs/plan/dictionary.html) — what every dictionary command,
 * GET /v1/env and the delete jobs share. Not a command (lives outside commands/).
 *
 *   dictionaryRef / contentRef     typed references
 *   reachFor / loadDictionary      WHO IS THIS, HERE — dictionaryReach() decides
 *   readEntries                    the entries, parsed
 *   toDictionaryOut                the API shape
 *   dropGrantsTo                   a board / artifact / agent is gone: its grants go too
 *
 * A dictionary's people are its own. Boards, artifacts and agents reach it
 * only through a grant stored on it. A board token acting as a person reaches
 * none (it was issued for one board, like for a bucket).
 *
 * NO REACH IS A 404, NOT A 403: a dictionary is private, and "you may not"
 * would confirm that the id exists.
 */
import {
  COLLECTIONS,
  DICTIONARY_DEFAULT_INDICATOR,
  dictionaryCan,
  dictionaryReach,
  entriesOut,
  errors,
  indicatorOf,
  isAgentId,
  paths,
  type BoardRole,
  type Dictionary,
  type DictionaryEntry,
  type DictionaryOut,
  type DictionaryReach,
  type DictionaryRole,
  type Uid,
} from '@tm/shared';
import { boardRolesFor, callerBoardRoles, isBoardTokenAsPerson } from '../bucket/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { txGet, type Tx } from '../runtime/tx.js';

const C = COLLECTIONS;

export const dictionariesCol = () => typedCol('dictionaries', C.dictionaries);
export const dictionaryRef = (id: string) => typedDoc('dictionaries', paths.dictionary(id));
export const contentRef = (id: string) =>
  typedDoc('dictionaryContent', paths.dictionaryContent(id));

export type DictionaryNeed = 'read' | 'write' | 'manage';

/** What the caller may do in this dictionary (null = nothing; answer 404). */
export async function reachFor(
  ctx: ServerCtx,
  d: Dictionary | undefined,
  tx?: Tx,
  boardRoles?: ReadonlyMap<string, BoardRole>,
): Promise<DictionaryReach> {
  if (!d) return null;
  if (isBoardTokenAsPerson(ctx)) return null;
  const agent = isAgentId(ctx.actor);
  const uid = agent ? null : ctx.actor;
  const owner = !!uid && d.access[uid] === 'owner';
  const roles = owner ? new Map() : (boardRoles ?? (await boardRolesFor(ctx, d, tx)));
  return dictionaryReach(d, { uid, boardRoles: roles, agentId: agent ? ctx.actor : null });
}

const REFUSAL: Record<DictionaryNeed, string> = {
  read: 'You cannot open this dictionary',
  write: 'You can read this dictionary but not change it',
  manage: 'Only the owner of this dictionary can do that',
};

export interface LoadedDictionary {
  dictionary: Dictionary;
  reach: Exclude<DictionaryReach, null>;
}

/** Read a dictionary (in `tx` when given) and gate it: 404 without reach, 403 with too little. */
export async function loadDictionary(
  tx: Tx | null,
  id: string,
  ctx: ServerCtx,
  need: DictionaryNeed,
): Promise<LoadedDictionary> {
  const ref = dictionaryRef(id);
  const d = tx ? await txGet(tx, ref) : (await ref.get()).data();
  const reach = await reachFor(ctx, d, tx ?? undefined);
  if (!d || !reach) {
    if (d && isBoardTokenAsPerson(ctx) && d.access[ctx.actor])
      throw errors.forbidden(
        'A board token cannot reach a dictionary — use an account token (Account › Tokens)',
      );
    throw errors.not_found('Dictionary not found');
  }
  const ok =
    need === 'read'
      ? dictionaryCan.read(reach)
      : need === 'write'
        ? dictionaryCan.write(reach)
        : dictionaryCan.manage(reach);
  if (need === 'write' && d.archivedAt !== null)
    throw errors.conflict('This dictionary is archived — restore it first');
  if (!ok) throw errors.forbidden(REFUSAL[need]);
  return { dictionary: d, reach };
}

/** `access` with its derived list. The ONLY way memberUids is ever computed. */
export function withMembers(access: Record<Uid, DictionaryRole>): {
  access: Record<Uid, DictionaryRole>;
  memberUids: Uid[];
} {
  return { access, memberUids: Object.keys(access).sort() };
}

/** A grants map with its derived id list (boards → boardIds, …). */
export const grantIds = (m: Record<string, unknown>): string[] => Object.keys(m).sort();

export const toDictionaryOut = (
  id: string,
  d: Dictionary,
  reach: Exclude<DictionaryReach, null>,
): DictionaryOut => ({
  id,
  name: d.name,
  description: d.description,
  indicator: indicatorOf(d, id, DICTIONARY_DEFAULT_INDICATOR),
  handle: d.ownerHandle ?? null,
  slug: d.slug ?? null,
  reach,
  archived: d.archivedAt !== null,
  stats: d.stats,
  updatedAt: d.updatedAt,
});

/** The entries of one dictionary, parsed, and when they last changed. */
export async function readEntries(
  id: string,
  tx?: Tx,
): Promise<{ entries: DictionaryEntry[]; updatedAt: number | null }> {
  const c = tx ? await txGet(tx, contentRef(id)) : (await contentRef(id).get()).data();
  return { entries: entriesOut(c), updatedAt: c?.updatedAt ?? null };
}

/**
 * Every dictionary the caller reaches, optionally narrowed to what one
 * board / artifact / agent was granted. `roles` = the caller's board roles
 * (callerBoardRoles), computed once.
 */
export async function reachableDictionaries(
  ctx: ServerCtx,
  narrow: { boardId?: string; artifactId?: string; agentId?: string } = {},
  roles?: ReadonlyMap<string, BoardRole>,
): Promise<{ id: string; d: Dictionary; reach: Exclude<DictionaryReach, null> }[]> {
  if (isBoardTokenAsPerson(ctx)) return [];
  const boardRoles = roles ?? (await callerBoardRoles(ctx));
  const agent = isAgentId(ctx.actor);
  const found = new Map<string, Dictionary>();
  const add = (docs: { id: string; data: () => Dictionary }[]) => {
    for (const s of docs) found.set(s.id, s.data());
  };
  if (narrow.boardId)
    add((await dictionariesCol().where('boardIds', 'array-contains', narrow.boardId).get()).docs);
  else if (narrow.artifactId)
    add(
      (await dictionariesCol().where('artifactIds', 'array-contains', narrow.artifactId).get())
        .docs,
    );
  else if (narrow.agentId)
    add((await dictionariesCol().where('agentIds', 'array-contains', narrow.agentId).get()).docs);
  else {
    if (!agent)
      add((await dictionariesCol().where('memberUids', 'array-contains', ctx.actor).get()).docs);
    else add((await dictionariesCol().where('agentIds', 'array-contains', ctx.actor).get()).docs);
    const ids = [...boardRoles.keys()];
    for (let i = 0; i < ids.length; i += 30)
      add(
        (
          await dictionariesCol()
            .where('boardIds', 'array-contains-any', ids.slice(i, i + 30))
            .get()
        ).docs,
      );
  }
  const uid = agent ? null : ctx.actor;
  const out: { id: string; d: Dictionary; reach: Exclude<DictionaryReach, null> }[] = [];
  for (const [id, d] of found) {
    const reach = dictionaryReach(d, { uid, boardRoles, agentId: agent ? ctx.actor : null });
    if (reach) out.push({ id, d, reach });
  }
  out.sort((a, b) => a.d.name.localeCompare(b.d.name) || a.id.localeCompare(b.id));
  return out;
}

/**
 * A board, an artifact or an agent was deleted: every grant naming it goes
 * (best effort — a grant to nothing reaches nothing, but it would still show
 * in the dictionary's Subscribers).
 */
export async function dropGrantsTo(
  kind: 'board' | 'artifact' | 'agent',
  id: string,
): Promise<void> {
  const field = `${kind}Ids` as const;
  const map = kind === 'board' ? 'boards' : kind === 'artifact' ? 'artifacts' : 'agents';
  const snap = await db().collection(C.dictionaries).where(field, 'array-contains', id).get();
  for (const s of snap.docs) {
    const grants = { ...((s.data() as Record<string, Record<string, string>>)[map] ?? {}) };
    delete grants[id];
    await s.ref
      .update({ [map]: grants, [field]: grantIds(grants), updatedAt: Date.now() })
      .catch(() => {});
  }
}
