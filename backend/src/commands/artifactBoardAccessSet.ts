/**
 * artifactBoardAccessSet (artifacts.html §K) — owner only: let the artifact's
 * page use a board's tickets through the driver, read or read-and-write, or
 * take that away (access null).
 *
 * The grant is a CEILING. The broker in the host page acts as the viewer, so
 * what anyone sees or changes through the page is still bounded by their own
 * role on the board. The owner may only grant what they hold themselves:
 * 'read' needs them on the board, 'write' needs them editor or admin there.
 */
import { ARTIFACT_BOARDS_MAX, effectiveRole, errors, type Artifact } from '@tm/shared';
import { artifactRef, loadArtifact } from '../artifacts/shared.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { loadBoard } from './boardShared.js';

export default defineCommand(
  'artifactBoardAccessSet',
  async (ctx, { artifactId, boardId, access }) => {
    await runTx(async (tx) => {
      const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
      const boards = { ...(artifact.boards ?? {}) };
      if (access === null) {
        if (!Object.prototype.hasOwnProperty.call(boards, boardId)) return;
        delete boards[boardId];
      } else {
        // Removing needs nothing; granting needs the owner to hold it themselves.
        const board = await loadBoard(tx, boardId, { ...ctx, scopes: undefined }, 'read');
        const role = effectiveRole(board, ctx.actor);
        if (access === 'write' && role !== 'admin' && role !== 'editor')
          throw errors.forbidden('Only an editor or admin of that board can grant write');
        if (!(boardId in boards) && Object.keys(boards).length >= ARTIFACT_BOARDS_MAX)
          throw errors.conflict(`An artifact can use at most ${ARTIFACT_BOARDS_MAX} boards`);
        boards[boardId] = access;
      }
      const patch: Partial<Artifact> = { boards, updatedAt: ctx.now };
      tx.update(artifactRef(artifactId), patch);
    });
    return { ok: true as const };
  },
);
