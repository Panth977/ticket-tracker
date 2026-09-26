/**
 * parseRichText with its board lookups done (app/backend.json
 * proxyFunctions.parseRichText):
 *
 *   mentions = mention nodes whose uid is on THIS board (members/)
 *   refs     = ticketRef nodes on boards the AUTHOR can read (keys/ + can(read))
 *   text     = plain render with current names and keys
 *
 * The pure part (validation, unmention, derive) lives in @tm/shared; this
 * module only fetches what it needs to answer isMember / canRef / nameOf / keyOf.
 */
import {
  paths,
  type Board,
  type BoardMember,
  type BoardWithId,
  type PMNode,
  type RichText,
} from '@tm/shared';
import { can, parseRichText, validateDoc, type CanCtx } from '@tm/shared/logic/index';
import { db } from '../runtime/firebase.js';
import { withBoardId } from './access.js';
import { locateTickets, type TicketLocation } from './locate.js';
import { isMember } from './validate.js';

export interface ParsedBody {
  rich: RichText;
  /** Where each ref in rich.refs lives (for referencedBy writes). */
  refAt: Map<string, TicketLocation>;
}

/** Every mention uid and ticketRef id in a doc (no validation). */
export function collectNodes(
  nodes: readonly PMNode[] | undefined,
  acc = { uids: new Set<string>(), refs: new Set<string>() },
) {
  for (const n of nodes ?? []) {
    if (n.type === 'mention' && typeof n.attrs?.uid === 'string') acc.uids.add(n.attrs.uid);
    if (n.type === 'ticketRef' && typeof n.attrs?.ticketId === 'string')
      acc.refs.add(n.attrs.ticketId);
    collectNodes(n.content, acc);
  }
  return acc;
}

/** Current display names of board members (members/ rows), by uid. */
export async function memberNames(
  boardId: string,
  uids: Iterable<string>,
): Promise<Map<string, string>> {
  const list = [...new Set(uids)];
  const out = new Map<string, string>();
  if (!list.length) return out;
  const snaps = await db().getAll(...list.map((u) => db().doc(paths.member(boardId, u))));
  for (const s of snaps) if (s.exists) out.set(s.id, (s.data() as BoardMember).name);
  return out;
}

/**
 * Validate + clean + derive a body arriving from any door. `selfId` is the
 * ticket the body belongs to (a self-reference is dropped from refs).
 */
export async function parseBody(
  input: unknown,
  board: BoardWithId,
  ctx: CanCtx,
  selfId?: string,
): Promise<ParsedBody> {
  const doc = validateDoc(input); // 400 / 413 before any lookups
  const { uids, refs } = collectNodes(doc.content);

  const names = await memberNames(
    board.id,
    [...uids].filter((u) => isMember(board, u)),
  );
  const located = await locateTickets(
    [...refs].filter((r) => r !== selfId),
    board.id,
  );

  // The AUTHOR must be able to read the board a ref lives on.
  const otherBoards = [...new Set([...located.values()].map((l) => l.boardId))].filter(
    (b) => b !== board.id,
  );
  const readable = new Set<string>([board.id]);
  if (otherBoards.length) {
    const snaps = await db().getAll(...otherBoards.map((b) => db().doc(paths.board(b))));
    for (const s of snaps) {
      if (s.exists && can(ctx, withBoardId(s.id, s.data() as Board), 'read')) readable.add(s.id);
    }
  }
  const refAt = new Map<string, TicketLocation>();
  for (const [id, loc] of located) if (readable.has(loc.boardId)) refAt.set(id, loc);

  const rich = parseRichText(doc, {
    isMember: (uid) => isMember(board, uid),
    canRef: (id) => refAt.has(id),
    nameOf: (uid) => names.get(uid),
    keyOf: (id) => located.get(id)?.key,
  });
  return { rich, refAt };
}
