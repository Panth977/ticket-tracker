/**
 * accountDelete — themselves, after a recent login (the client re-authenticates
 * and sends recentLogin: true).
 *
 *   the only admin of a board that has other people on it → 409 naming the
 *     boards (make someone else admin, or delete the board) — checked first,
 *     before anything changes
 *   boards where they were the only person → deleted (key tombstoned, queued purge)
 *   every other board → left (boardAccessSet leave: off tickets, members/ row gone)
 *   users/{uid}: name 'Deleted user', email / WhatsApp / avatar cleared,
 *     deletedAt = now; picture deleted; devices, inbox, reads, API keys and
 *     app grants deleted
 *   Auth account deleted.
 *
 * Messages STAY, authored by 'Deleted user' — deleting them would rewrite
 * other people's conversations.
 */
import { errors, paths, storage, type BoardWithId } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { typedCol } from '../runtime/converters.js';
import { auth, db } from '../runtime/firebase.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { applyAccess } from './boardAccessSet.js';
import { adminCount, afterBoardDeleted, deleteBoardTx, loadBoard } from './boardShared.js';
import { newUserDoc, userRef } from './profileShared.js';
import { memoriesCol, memoryRef, withMembers } from '../memory/shared.js';

export default defineCommand('accountDelete', async (ctx) => {
  const uid = ctx.actor;
  const snap = await typedCol('boards', paths.boards())
    .where('readerUids', 'array-contains', uid)
    .get();
  const boards: BoardWithId[] = snap.docs.map((d) => ({ ...d.data(), id: d.id }));

  const blocking = boards.filter(
    (b) => b.access[uid] === 'admin' && adminCount(b.access) === 1 && b.readerUids.length > 1,
  );
  if (blocking.length)
    throw errors.conflict(
      'You are the only admin of boards other people use — make someone else admin, or delete them',
      { boards: blocking.map((b) => ({ boardId: b.id, name: b.name, key: b.key })) },
    );

  for (const b of boards) {
    if (b.readerUids.length === 1) {
      await runTx(async (tx) => {
        const fresh = await loadBoard(tx, b.id, ctx, 'read');
        if (fresh.readerUids.length !== 1)
          throw errors.conflict('Someone joined one of your boards meanwhile — try again');
        deleteBoardTx(tx, fresh);
      });
      await afterBoardDeleted(b.id, ctx);
    } else {
      await applyAccess(ctx, { boardId: b.id, leave: true });
    }
  }

  // memory.html: the memories they OWN go (queued, like memoryDelete); their
  // role on anyone else's memory is taken away.
  const mine = await memoriesCol().where('memberUids', 'array-contains', uid).get();
  for (const d of mine.docs) {
    const m = d.data();
    if (m.ownerUid === uid) {
      await memoryRef(d.id).update({
        access: {},
        memberUids: [],
        boards: {},
        boardIds: [],
        artifacts: {},
        deletingAt: ctx.now,
        updatedAt: ctx.now,
      });
      await ports().queue.enqueue(
        'memoryDelete',
        { memoryId: d.id, actor: uid },
        { name: `memoryDelete-${d.id}` },
      );
    } else {
      const access = { ...m.access };
      delete access[uid];
      await memoryRef(d.id).update({ ...withMembers(access), updatedAt: ctx.now });
    }
  }

  // Soft-delete the profile: the uid keeps rendering as 'Deleted user'.
  const ref = userRef(uid);
  const deleted = {
    name: 'Deleted user',
    email: '',
    avatarPath: null,
    whatsapp: null,
    deletedAt: ctx.now,
  };
  if ((await ref.get()).exists) await ref.update(deleted);
  else await ref.set({ ...newUserDoc({}, ctx.now), ...deleted });

  await ports()
    .files.deletePrefix(storage.avatarPrefix(uid))
    .catch((e) => console.warn('[accountDelete] avatar cleanup failed', e));
  for (const sub of [
    paths.devices(uid),
    paths.inbox(uid),
    paths.reads(uid),
    paths.apiKeys(uid),
    paths.oauthGrants(uid),
  ])
    await db().recursiveDelete(db().collection(sub));

  await auth()
    .deleteUser(uid)
    .catch((e: { code?: string }) => {
      if (e.code !== 'auth/user-not-found') throw e;
    });
  return { ok: true as const };
});
