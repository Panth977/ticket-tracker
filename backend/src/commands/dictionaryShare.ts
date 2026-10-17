/**
 * dictionaryShare (dictionary.html §C) — owner only, never an agent: give a
 * PERSON a role by email ('editor' | 'viewer'), or take it away (null). Like
 * a bucket, the person must already have an account here.
 */
import { errors, isAgentId, type DictionaryRole } from '@tm/shared';
import { normalizeEmail } from '@tm/shared/config';
import { dictionaryRef, loadDictionary, withMembers } from '../dictionary/shared.js';
import { assertAllowedOwner } from '../platform/allow.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { uidForEmail } from './inviteShared.js';

const has = (map: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key);

export default defineCommand('dictionaryShare', async (ctx, { dictionaryId, email: raw, role }) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot share a dictionary');
  const email = normalizeEmail(raw);
  const uid = await uidForEmail(email);
  if (!uid) {
    if (role === null) return { ok: true as const };
    throw errors.conflict(
      `${email} has no account here yet — ask them to sign in once, then share again`,
      { reason: 'noAccount', email },
    );
  }
  if (role !== null) {
    try {
      await assertAllowedOwner(uid);
    } catch {
      throw errors.conflict(
        `${email} is not allowed to use this TaskManager yet — the admin has to add them first`,
        { reason: 'notAllowed', email },
      );
    }
  }
  await runTx(async (tx) => {
    const { dictionary: d } = await loadDictionary(tx, dictionaryId, ctx, 'manage');
    if (uid === d.ownerUid) throw errors.conflict("The owner's own role cannot be changed");
    const access: Record<string, DictionaryRole> = { ...d.access };
    if (role === null) {
      if (!has(access, uid)) return;
      delete access[uid];
    } else {
      if (access[uid] === role) return;
      access[uid] = role;
    }
    tx.update(dictionaryRef(dictionaryId), { ...withMembers(access), updatedAt: ctx.now });
  });
  return { ok: true as const };
});
