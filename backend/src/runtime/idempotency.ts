/**
 * Idempotency by clientId: a retried request is ONE change.
 *
 *   _idem/{uid}_{clientId} = { command, status: 'pending' | 'done', resJson?, createdAt, expiresAt }
 *
 * The response is stored as a JSON string: Firestore cannot hold every JSON
 * value (nested arrays), and a replay must be byte-identical anyway.
 *
 * claim() runs in a transaction: a finished record replays its stored
 * response; a fresh 'pending' one means the same request is in flight → 409;
 * otherwise we write 'pending' and run. On success the response is stored;
 * on failure the record is deleted so a corrected retry can run.
 *
 * `expiresAt` is a Firestore Timestamp so a TTL policy on `_idem.expiresAt`
 * reaps records after 24h; until the reaper runs, expired records are
 * treated as absent here.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { errors, paths } from '@tm/shared';
import { db } from './firebase.js';

export const IDEM_TTL_MS = 24 * 60 * 60 * 1000;
/** A 'pending' record older than this is from a crashed attempt and may be taken over. */
export const IDEM_STALE_PENDING_MS = 2 * 60 * 1000;

interface IdemRecord {
  command: string;
  status: 'pending' | 'done';
  resJson?: string;
  createdAt: number;
  expiresAt: Timestamp;
}

export type Claim =
  | { kind: 'replay'; res: unknown }
  | { kind: 'claimed'; complete(res: unknown): Promise<void>; release(): Promise<void> };

export async function claimIdempotency(
  uid: string,
  clientId: string,
  command: string,
  now: number,
): Promise<Claim> {
  const ref = db().doc(paths.idem(uid, clientId));
  const replay = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const rec = snap.exists ? (snap.data() as IdemRecord) : undefined;
    if (rec && rec.expiresAt.toMillis() > now) {
      if (rec.command !== command) {
        throw errors.conflict('This clientId was already used for a different command', {
          clientId,
        });
      }
      if (rec.status === 'done')
        return { res: rec.resJson === undefined ? null : (JSON.parse(rec.resJson) as unknown) };
      if (now - rec.createdAt < IDEM_STALE_PENDING_MS) {
        throw errors.conflict('The same request is still being processed', {
          clientId,
          retryAfter: 2,
        });
      }
    }
    const fresh: IdemRecord = {
      command,
      status: 'pending',
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now + IDEM_TTL_MS),
    };
    tx.set(ref, fresh);
    return null;
  });
  if (replay) return { kind: 'replay', res: replay.res };
  return {
    kind: 'claimed',
    async complete(res) {
      await ref.set({ status: 'done', resJson: JSON.stringify(res ?? null) }, { merge: true });
    },
    async release() {
      await ref.delete();
    },
  };
}
