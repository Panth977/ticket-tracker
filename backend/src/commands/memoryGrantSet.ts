/**
 * memoryGrantSet (memory.html §D) — let a board or an artifact use this
 * memory ('read' | 'write'), or stop it (null).
 *
 * BOTH SIDES must agree, so the caller must own the memory AND be an admin of
 * the board (or the owner of the artifact). Removing needs only the memory:
 * the owner can always take their memory back. Never an agent.
 */
import { errors, isAgentId, MEMORY_GRANTS_MAX, type Memory } from '@tm/shared';
import { loadArtifact } from '../artifacts/shared.js';
import { loadMemory, memoryRef } from '../memory/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

export default defineCommand(
  'memoryGrantSet',
  async (ctx, { memoryId, boardId, artifactId, access }) => {
    if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot grant a memory');
    await runTx(async (tx) => {
      const { memory } = await loadMemory(tx, memoryId, ctx, 'manage');
      const patch: Partial<Memory> = { updatedAt: ctx.now };
      if (boardId) {
        const boards = { ...memory.boards };
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
    });
    return { ok: true as const };
  },
);
