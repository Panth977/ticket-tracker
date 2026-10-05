/**
 * memoryGrantSet (memory.html §D) — let a board or an artifact use this
 * memory ('read' | 'write'), or stop it (null).
 *
 * BOTH SIDES must agree to GRANT, so the caller must own the memory AND be an
 * admin of the board (or the owner of the artifact). EITHER SIDE may END it
 * (access null): the memory's owner takes their memory back, a board admin
 * drops it from the board (board settings › Subscriptions), the artifact's
 * owner drops it from the artifact. A caller who is neither learns nothing
 * about the memory (404). Never an agent.
 *
 * memory.html §J: a board whose attachment memory this is (board.attachMemory)
 * loses that default, in the same transaction, when the board's `write` goes
 * (removed, or lowered to read).
 */
import { errors, isAgentId, MEMORY_GRANTS_MAX, type Memory } from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { loadArtifact } from '../artifacts/shared.js';
import { loadMemory, memoryRef } from '../memory/shared.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { boardRef, loadBoard } from './boardShared.js';

export default defineCommand(
  'memoryGrantSet',
  async (ctx, { memoryId, boardId, artifactId, access }) => {
    if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot grant a memory');
    await runTx(async (tx) => {
      const memory =
        access === null
          ? await loadForRevoke(tx, memoryId, ctx, { boardId, artifactId })
          : (await loadMemory(tx, memoryId, ctx, 'manage')).memory;
      if (!memory) return;
      const patch: Partial<Memory> = { updatedAt: ctx.now };
      let unsetDefault = false;
      if (boardId) {
        const boards = { ...memory.boards };
        // §J: the board's default attachment memory stops being one without write.
        if (access !== 'write' && boards[boardId] === 'write') {
          const b = await txGet(tx, boardRef(boardId));
          unsetDefault = b?.attachMemory?.memoryId === memoryId;
        }
        if (access === null) {
          if (!Object.prototype.hasOwnProperty.call(boards, boardId)) return;
          delete boards[boardId];
        } else {
          // 'admin' — board settings are where a board's memories are chosen.
          await loadBoard(tx, boardId, { ...ctx, scopes: undefined }, 'admin');
          if (!(boardId in boards) && Object.keys(boards).length >= MEMORY_GRANTS_MAX)
            throw errors.conflict(`A memory can be used by at most ${MEMORY_GRANTS_MAX} boards`);
          if (boards[boardId] === access) return;
          boards[boardId] = access;
        }
        patch.boards = boards;
        patch.boardIds = Object.keys(boards).sort();
      } else if (artifactId) {
        const artifacts = { ...memory.artifacts };
        if (access === null) {
          if (!Object.prototype.hasOwnProperty.call(artifacts, artifactId)) return;
          delete artifacts[artifactId];
        } else {
          await loadArtifact(tx, artifactId, { ...ctx, scopes: undefined }, 'manage');
          if (!(artifactId in artifacts) && Object.keys(artifacts).length >= MEMORY_GRANTS_MAX)
            throw errors.conflict(`A memory can be used by at most ${MEMORY_GRANTS_MAX} artifacts`);
          if (artifacts[artifactId] === access) return;
          artifacts[artifactId] = access;
        }
        patch.artifacts = artifacts;
      }
      tx.update(memoryRef(memoryId), patch);
      if (boardId && unsetDefault)
        tx.update(boardRef(boardId), { attachMemory: null, updatedAt: ctx.now });
    });
    return { ok: true as const };
  },
);

/**
 * Who may END a grant: the memory's owner, or — for THAT grant only — an admin
 * of the board / the owner of the artifact. Answers the memory, or null when
 * there is nothing to remove (the side asking already lost it). Anyone else:
 * 404 when the memory is out of their reach, 403 when it is in it.
 */
async function loadForRevoke(
  tx: Tx,
  memoryId: string,
  ctx: ServerCtx,
  target: { boardId?: string | undefined; artifactId?: string | undefined },
): Promise<Memory | null> {
  const memory = await txGet(tx, memoryRef(memoryId));
  if (!memory || memory.deletingAt) throw errors.not_found('Memory not found');
  const own = Object.prototype.hasOwnProperty.call(memory.access, ctx.actor);
  if (own && memory.access[ctx.actor] === 'owner') return memory;
  const plain = { ...ctx, scopes: undefined };
  const granted = target.boardId
    ? Object.prototype.hasOwnProperty.call(memory.boards ?? {}, target.boardId)
    : Object.prototype.hasOwnProperty.call(memory.artifacts ?? {}, target.artifactId ?? '');
  if (target.boardId) {
    // Not on the board → 404; on it but not admin → 403 (its members reach the memory anyway).
    await loadBoard(tx, target.boardId, plain, 'admin');
  } else if (target.artifactId) {
    await loadArtifact(tx, target.artifactId, plain, 'manage');
  }
  // The other side never had it: say nothing about the memory.
  if (!granted) {
    if (own) return null;
    throw errors.not_found('Memory not found');
  }
  return memory;
}
