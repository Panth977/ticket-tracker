/**
 * Transaction helpers. Every command that touches more than one document
 * writes inside ONE transaction; side effects (notify, emitWebhook, enqueue)
 * run only AFTER it commits — a retried transaction must never notify twice.
 *
 *   const { ticket } = await runTx(async (tx) => {
 *     const board = await mustGet(tx, typedDoc('boards', paths.board(id)), 'Board not found');
 *     …
 *     return { ticket };
 *   });
 *   await notify('created', ticket, ctx);
 */
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { errors, type AppErrorCode } from '@tm/shared';
import { db } from './firebase.js';

export type Tx = Transaction;

/** Run `fn` in a Firestore transaction (retried by the SDK on contention). */
export function runTx<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { maxAttempts?: number } = {},
): Promise<T> {
  return db().runTransaction(fn, { maxAttempts: opts.maxAttempts ?? 5 });
}

/** Read inside a transaction; undefined when missing. */
export async function txGet<T>(tx: Tx, ref: DocumentReference<T>): Promise<T | undefined> {
  const snap = await tx.get(ref);
  return snap.exists ? snap.data() : undefined;
}

/**
 * Read inside a transaction or throw an AppError (default not_found — which
 * is also what a board you cannot read answers: never leak existence).
 */
export async function mustGet<T>(
  tx: Tx,
  ref: DocumentReference<T>,
  message?: string,
  code: AppErrorCode = 'not_found',
): Promise<T> {
  const data = await txGet(tx, ref);
  if (data === undefined) throw errors[code](message);
  return data;
}

/** Read several refs in one round trip; each entry undefined when missing. Order preserved. */
export async function txGetAll<T>(
  tx: Tx,
  refs: DocumentReference<T>[],
): Promise<(T | undefined)[]> {
  if (refs.length === 0) return [];
  const snaps = await tx.getAll(...refs);
  return snaps.map((s) => (s.exists ? s.data() : undefined));
}

/** Non-transactional convenience: get a doc's data or undefined. */
export async function getDoc<T>(ref: DocumentReference<T>): Promise<T | undefined> {
  const snap = await ref.get();
  return snap.exists ? snap.data() : undefined;
}
