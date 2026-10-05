/**
 * boardArtifactList (artifacts.html §K, from the board's side) — the artifacts
 * whose page may use this board's tickets, for board settings › Subscribers.
 *
 * A person on the board may ask (it is their board's audience). An artifact
 * is private to its people, so its name and indicator are answered only to
 * someone with a role on it; everyone else gets its id, its owner and the
 * grant — enough for a board admin to take the board away
 * (artifactBoardAccessSet with access null).
 *
 * The query reads one map key (boards.<boardId>), which Firestore indexes on
 * its own; deleted artifacts are left out.
 */
import { FieldPath } from 'firebase-admin/firestore';
import { errors, indicatorOf, isAgentId } from '@tm/shared';
import { artifactsCol } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';
import { loadBoardNoTx } from './boardShared.js';

export default defineCommand('boardArtifactList', async (ctx, { boardId }) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot list a board’s artifacts');
  await loadBoardNoTx(boardId, { ...ctx, scopes: undefined }, 'read');
  const snap = await artifactsCol()
    .where(new FieldPath('boards', boardId), 'in', ['read', 'write'])
    .get();
  const artifacts = snap.docs
    .map((d) => ({ id: d.id, a: d.data() }))
    .filter(({ a }) => !a.deletingAt && a.boards?.[boardId])
    .map(({ id, a }) => {
      const mine = Object.prototype.hasOwnProperty.call(a.access, ctx.actor);
      return {
        artifactId: id,
        access: a.boards![boardId]!,
        ownerUid: a.ownerUid,
        name: mine ? a.name : null,
        indicator: mine ? indicatorOf(a, id) : null,
      };
    })
    .sort((x, y) => (x.name ?? '￿').localeCompare(y.name ?? '￿'));
  return { artifacts };
});
