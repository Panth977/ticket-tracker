/**
 * artifactBoardAccessSet (artifacts.html §K) — owner only: let the artifact's
 * page use a board's tickets through the driver, read or read-and-write, or
 * take that away (access null). Taking it away is EITHER SIDE's call: the
 * artifact's owner, or an admin of that board (board settings › Subscribers)
 * — a person, never an agent, and only for that board's own grant.
 *
 * The grant is a CEILING. The broker in the host page acts as the viewer, so
 * what anyone sees or changes through the page is still bounded by their own
 * role on the board. The owner may only grant what they hold themselves:
 * 'read' needs them on the board, 'write' needs them editor or admin there.
 */
import {
  ARTIFACT_BOARDS_MAX,
  can,
  effectiveRole,
  errors,
  isAgentId,
  type Artifact,
} from '@tm/shared';
import { artifactRef, loadArtifact, roleFor } from '../artifacts/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { boardRef, loadBoard } from './boardShared.js';

export default defineCommand(
  'artifactBoardAccessSet',
  async (ctx, { artifactId, boardId, access }) => {
    await runTx(async (tx) => {
      const artifact =
        access === null
          ? await loadForRevoke(tx, artifactId, boardId, ctx)
          : (await loadArtifact(tx, artifactId, ctx, 'manage')).artifact;
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

/**
 * Who may take a board away: the artifact's owner — or an admin of THAT board,
 * who may only drop that board's own grant. Anyone else gets what they would
 * have got before (404 / 403 from the owner's gate).
 */
async function loadForRevoke(
  tx: Tx,
  artifactId: string,
  boardId: string,
  ctx: ServerCtx,
): Promise<Artifact> {
  const raw = await txGet(tx, artifactRef(artifactId));
  const owner = !!raw && !raw.deletingAt && !isAgentId(ctx.actor) && raw.ownerUid === ctx.actor;
  if (owner || !raw || raw.deletingAt || isAgentId(ctx.actor))
    return (await loadArtifact(tx, artifactId, ctx, 'manage')).artifact;
  const granted = Object.prototype.hasOwnProperty.call(raw.boards ?? {}, boardId);
  const data = granted ? await txGet(tx, boardRef(boardId)) : undefined;
  const board = data ? { ...data, id: boardId } : null;
  const plain = { ...ctx, scopes: undefined };
  // The board's side: its admin (a person — agents were sent to the owner's gate above).
  if (board && can(plain, board, 'admin')) return raw;
  // Someone on the board sees this grant (board settings › Subscribers): say why not.
  if (board && can(plain, board, 'read') && !roleFor(ctx, raw))
    throw errors.forbidden('Only the artifact’s owner or an admin of the board can remove it');
  return (await loadArtifact(tx, artifactId, ctx, 'manage')).artifact;
}
