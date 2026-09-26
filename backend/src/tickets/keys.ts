/**
 * allocateKey (app/backend.json proxyFunctions.allocateKey): A COUNTER ON THE
 * BOARD DOCUMENT, not a query for max(number). Runs inside the caller's
 * transaction, after its reads:
 *
 *   n = board.nextNumber
 *   tx.update(board, { nextNumber: n + 1 })
 *   tx.create(keys/{KEY}-{n}, { ticketId, boardId, current })
 *
 * The board doc takes ~1 sustained write/sec — one new ticket per second per
 * board; allocateRange takes several at once with a single counter bump.
 * tx.create means a key can never be issued twice: a tombstoned or
 * redirected keys/ doc makes the transaction fail rather than overwrite it.
 */
import type { DocumentReference } from 'firebase-admin/firestore';
import { paths, type Board, type KeyIndex, type TicketKey } from '@tm/shared';
import { ticketKey } from '@tm/shared/logic/index';
import { typedDoc } from '../runtime/converters.js';
import type { Tx } from '../runtime/tx.js';

export const keyRef = (key: string): DocumentReference<KeyIndex> =>
  typedDoc('keys', paths.key(key));

export interface Allocated {
  key: TicketKey;
  number: number;
}

/** Allocate one key for `ticketId` (board read earlier in the same tx). */
export function allocateKey(
  tx: Tx,
  ref: DocumentReference<Board>,
  board: Pick<Board, 'key' | 'nextNumber'>,
  boardId: string,
  ticketId: string,
): Allocated {
  return allocateRange(tx, ref, board, boardId, [ticketId])[0]!;
}

/** Allocate consecutive keys for several tickets with ONE counter write. */
export function allocateRange(
  tx: Tx,
  ref: DocumentReference<Board>,
  board: Pick<Board, 'key' | 'nextNumber'>,
  boardId: string,
  ticketIds: readonly string[],
): Allocated[] {
  const start = board.nextNumber;
  tx.update(ref, { nextNumber: start + ticketIds.length });
  return ticketIds.map((ticketId, i) => {
    const number = start + i;
    const key = ticketKey(board.key, number);
    tx.create(keyRef(key), { ticketId, boardId, current: key });
    return { key, number };
  });
}
