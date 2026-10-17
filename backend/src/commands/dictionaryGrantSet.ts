/**
 * dictionaryGrantSet (dictionary.html §D) — let a board, an artifact or an
 * agent use this dictionary ('read' | 'write'), or stop it (null).
 *
 * BOTH SIDES must agree to GRANT: the caller owns the dictionary AND is an
 * admin of the board / the owner of the artifact / the owner of the agent.
 * EITHER SIDE may END it. A caller who is neither learns nothing about the
 * dictionary (404). Never an agent.
 */
import {
  DICTIONARY_GRANTS_MAX,
  errors,
  isAgentId,
  paths,
  type Dictionary,
  type DictionaryGrant,
} from '@tm/shared';
import { loadArtifact } from '../artifacts/shared.js';
import { db } from '../db/index.js';
import { dictionaryRef, grantIds, loadDictionary } from '../dictionary/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

type Side =
  | { kind: 'board'; id: string; map: 'boards'; ids: 'boardIds' }
  | { kind: 'artifact'; id: string; map: 'artifacts'; ids: 'artifactIds' }
  | { kind: 'agent'; id: string; map: 'agents'; ids: 'agentIds' };

const LABEL = { board: 'boards', artifact: 'artifacts', agent: 'agents' } as const;

export default defineCommand(
  'dictionaryGrantSet',
  async (ctx, { dictionaryId, boardId, artifactId, agentId, access }) => {
    if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot grant a dictionary');
    const side: Side = boardId
      ? { kind: 'board', id: boardId, map: 'boards', ids: 'boardIds' }
      : artifactId
        ? { kind: 'artifact', id: artifactId, map: 'artifacts', ids: 'artifactIds' }
        : { kind: 'agent', id: agentId!, map: 'agents', ids: 'agentIds' };
    await runTx(async (tx) => {
      const d =
        access === null
          ? await loadForRevoke(tx, dictionaryId, ctx, side)
          : (await loadDictionary(tx, dictionaryId, ctx, 'manage')).dictionary;
      if (!d) return;
      const grants: Record<string, DictionaryGrant> = { ...(d[side.map] ?? {}) };
      if (access === null) {
        if (!Object.prototype.hasOwnProperty.call(grants, side.id)) return;
        delete grants[side.id];
      } else {
        await requireOtherSide(tx, ctx, side);
        if (!(side.id in grants) && Object.keys(grants).length >= DICTIONARY_GRANTS_MAX)
          throw errors.conflict(
            `A dictionary can be used by at most ${DICTIONARY_GRANTS_MAX} ${LABEL[side.kind]}`,
          );
        if (grants[side.id] === access) return;
        grants[side.id] = access;
      }
      const patch: Partial<Dictionary> = {
        [side.map]: grants,
        [side.ids]: grantIds(grants),
        updatedAt: ctx.now,
      };
      tx.update(dictionaryRef(dictionaryId), patch);
    });
    return { ok: true as const };
  },
);

/** The caller manages the other side: board admin, artifact owner, agent owner. */
async function requireOtherSide(tx: Tx, ctx: ServerCtx, side: Side): Promise<void> {
  const plain = { ...ctx, scopes: undefined };
  if (side.kind === 'board') await loadBoard(tx, side.id, plain, 'admin');
  else if (side.kind === 'artifact') await loadArtifact(tx, side.id, plain, 'manage');
  else {
    const snap = await tx.get(db().doc(paths.agent(side.id)));
    const g = snap.data() as { ownerUid?: string } | undefined;
    if (!g) throw errors.not_found('No such agent');
    if (g.ownerUid !== ctx.actor)
      throw errors.forbidden('Only the agent’s owner can choose its dictionaries');
  }
}

/**
 * Who may END a grant: the dictionary's owner, or — for THAT grant only — the
 * other side's manager. Answers the dictionary, or null when there is nothing
 * to remove. Anyone else: 404.
 */
async function loadForRevoke(
  tx: Tx,
  dictionaryId: string,
  ctx: ServerCtx,
  side: Side,
): Promise<Dictionary | null> {
  const d = await txGet(tx, dictionaryRef(dictionaryId));
  if (!d) throw errors.not_found('Dictionary not found');
  const own = Object.prototype.hasOwnProperty.call(d.access, ctx.actor);
  if (own && d.access[ctx.actor] === 'owner') return d;
  await requireOtherSide(tx, ctx, side);
  const granted = Object.prototype.hasOwnProperty.call(d[side.map] ?? {}, side.id);
  if (!granted) {
    if (own) return null;
    throw errors.not_found('Dictionary not found');
  }
  return d;
}
