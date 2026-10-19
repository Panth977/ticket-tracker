/**
 * driveDocs (bucket.html §L, §L5) — what the browser would have read from
 * Firestore, for anything kept in Google Drive: a Drive board's tickets,
 * views, templates, webhooks, integrations and its own document (settings
 * merged in); a Drive dictionary's entries; a Drive artifact's data. Goes
 * through db() like every other reader, so the router answers from Drive.
 *
 * Who may read what is the same as Firestore's rules: a board's readers, a
 * dictionary's readers, an artifact's data readers. A group query covers
 * the caller's Drive boards' tickets (the browser reads the rest itself).
 *
 * Values travel encoded (a Timestamp as { __ts: ms }); the browser decodes them.
 */
import { errors, type Board } from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import { baseDb, db, type Query } from '../db/index.js';
import { driveBoardIds, driveBoardOf, driveEntityOf } from '../db/drive/board.js';
import { entityColLoc, entityLoc } from '../db/drive/entities.js';
import { docLoc } from '../db/drive/router.js';
import { encodeJson } from '../db/drive/values.js';
import { loadArtifact } from '../artifacts/shared.js';
import { loadDictionary } from '../dictionary/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { defineCommand } from './_registry.js';
import { loadBoardNoTx } from './boardShared.js';

const MAX_DOCS = 5000;

type Plain = Record<string, unknown>;
const plain = (d: unknown): Plain => (encodeJson(d ?? {}) ?? {}) as Plain;

/** Firestore's rule on views: the shared ones, and your own. */
const visible = (ctx: ServerCtx, path: string, data: Plain | undefined): boolean =>
  path.split('/')[2] !== 'views' || !data || data.scope === 'shared' || data.ownerUid === ctx.actor;

/** The entity a routed path belongs to, gated as Firestore's rules gate it. 404 when not a routed path. */
export async function gateDrivePath(
  ctx: ServerCtx,
  path: string,
  doc: boolean,
  write = false,
): Promise<{ kind: string; id: string; drive: boolean }> {
  const s = path.split('/');
  const routed = doc
    ? !!(docLoc(path) || entityLoc(path))
    : !!(entityColLoc(path) || (s[0] === 'boards' && s[2] === 'tickets' && s.length % 2 === 1));
  if (!routed || s.length < (doc ? 2 : 3))
    throw errors.invalid('Not a path kept in Drive', { field: 'target' });
  const [kind, id] = [s[0]!, s[1]!];
  if (kind === 'boards') {
    if (write) throw errors.forbidden('Board documents change through commands');
    const board = await loadBoardNoTx(id, ctx, 'read');
    // Firestore's rule: a board's webhooks are its admins' to read.
    if (s[2] === 'webhooks' && board.access[ctx.actor] !== 'admin')
      throw errors.forbidden('Only a board admin can read its webhooks');
    return { kind, id, drive: !!(await driveBoardOf(baseDb(), id)) };
  }
  if (kind === 'dictionaries') {
    if (write) throw errors.forbidden('Dictionary entries change through commands');
    await loadDictionary(null, id, ctx, 'read');
  } else if (kind === 'artifacts') {
    await loadArtifact(null, id, ctx, write ? 'writeData' : 'readData');
  } else throw errors.invalid('Not a path kept in Drive', { field: 'target' });
  return { kind, id, drive: !!(await driveEntityOf(baseDb(), kind as 'artifacts', id)) };
}

export default defineCommand('driveDocs', async (ctx, input) => {
  const shape = (q: Query) => {
    let out = q;
    for (const [f, op, v] of input.where ?? []) out = out.where(f, op, v);
    for (const [f, dir] of input.orderBy ?? []) out = out.orderBy(f, dir);
    if (input.startAfter?.length) out = out.startAfter(...input.startAfter);
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
  const isDoc = input.target.kind === 'doc';
  const g = await gateDrivePath(ctx, path, isDoc);
  const watch = g.drive && g.kind === 'boards' ? [g.id] : [];
  const entity = g.drive ? { kind: g.kind, id: g.id } : null;

  if (isDoc) {
    const snap = await db().doc(path).get();
    const ok = snap.exists && visible(ctx, path, snap.data() as Plain);
    return {
      docs: ok ? [{ path, id: snap.id, data: plain(snap.data()) }] : [],
      exists: ok,
      boards: watch,
      entity,
    };
  }
  const snap = await shape(db().collection(path)).get();
  return {
    docs: snap.docs
      .filter((d) => visible(ctx, d.ref.path, d.data() as Plain))
      .map((d) => ({ path: d.ref.path, id: d.id, data: plain(d.data()) })),
    boards: watch,
    entity,
  };
});
