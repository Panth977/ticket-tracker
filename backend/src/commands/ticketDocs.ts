/**
 * ticketDocs (bucket.html §L) — what the browser would have read from
 * Firestore, for a board whose tickets live in Google Drive. Goes through
 * db() like every other reader, so the ticket router answers from Drive.
 *
 * Only ticket paths of boards the caller can read; a group query covers the
 * caller's Drive boards (the database's boards the browser reads itself).
 */
import { errors, type Board } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { baseDb, db, type Query } from '../db/index.js';
import { driveBoardIds, driveBoardOf } from '../db/drive/board.js';
import { docLoc } from '../db/drive/router.js';
import { defineCommand } from './_registry.js';
import { loadBoardNoTx } from './boardShared.js';

const MAX_DOCS = 5000;

type Plain = Record<string, unknown>;
/** JSON for the wire (Timestamps as their JSON, nothing else special in a ticket). */
const plain = (d: unknown): Plain => JSON.parse(JSON.stringify(d ?? {})) as Plain;

export default defineCommand('ticketDocs', async (ctx, input) => {
  const shape = (q: Query) => {
    let out = q;
    for (const [f, op, v] of input.where ?? []) out = out.where(f, op, v);
    for (const [f, dir] of input.orderBy ?? []) out = out.orderBy(f, dir);
    return out.limit(Math.min(input.limit ?? MAX_DOCS, MAX_DOCS));
  };

  if (input.target.kind === 'group') {
    const ids = await driveBoardIds(baseDb());
    const boards = (
      await Promise.all(
        ids.map(async (id) => {
          const s = await baseDb().doc(`boards/${id}`).get();
          const b = s.exists ? ({ ...(s.data() as Board), id } as Board & { id: string }) : null;
          return b && can(ctx, b, 'read') ? id : null;
        }),
      )
    ).filter((x): x is string => !!x);
    const docs = (
      await Promise.all(
        boards.map(async (b) => (await shape(db().collection(`boards/${b}/tickets`)).get()).docs),
      )
    ).flat();
    return {
      docs: docs.map((d) => ({ path: d.ref.path, id: d.id, data: plain(d.data()) })),
      boards,
    };
  }

  const path = input.target.path.replace(/^\/+|\/+$/g, '');
  const s = path.split('/');
  const isDoc = input.target.kind === 'doc';
  if (isDoc ? !docLoc(path) : s[0] !== 'boards' || s[2] !== 'tickets' || s.length % 2 !== 1)
    throw errors.invalid('Not a ticket path', { field: 'target' });
  const boardId = s[1]!;
  await loadBoardNoTx(boardId, ctx, 'read');
  const drive = (await driveBoardOf(baseDb(), boardId)) ? [boardId] : [];

  if (isDoc) {
    const snap = await db().doc(path).get();
    return {
      docs: snap.exists ? [{ path, id: snap.id, data: plain(snap.data()) }] : [],
      exists: snap.exists,
      boards: drive,
    };
  }
  const snap = await shape(db().collection(path)).get();
  return {
    docs: snap.docs.map((d) => ({ path: d.ref.path, id: d.id, data: plain(d.data()) })),
    boards: drive,
  };
});
