/**
 * memoryShare (memory.html §B) — owner only, never an agent: give a PERSON a
 * role by email ('editor' | 'viewer'), or take it away (null).
 *
 * The person must already have an account here (and be on the allow list):
 * unlike boards and artifacts, a memory does not send invites yet — an
 * unknown address is a 409 that says so. `invited` is therefore always false.
 */
import { errors, isAgentId, type MemoryRole } from '@tm/shared';
import { normalizeEmail } from '@tm/shared/config';
import { loadMemory, memoryRef, withMembers } from '../memory/shared.js';
import { assertAllowedOwner } from '../platform/allow.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { uidForEmail } from './inviteShared.js';

const has = (map: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key);

export default defineCommand('memoryShare', async (ctx, { memoryId, email: raw, role }) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('An agent cannot share a memory');
  const email = normalizeEmail(raw);
  const uid = await uidForEmail(email);
  if (!uid) {
    if (role === null) return { ok: true as const, invited: false };
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
    const { memory } = await loadMemory(tx, memoryId, ctx, 'manage');
    if (uid === memory.ownerUid) throw errors.conflict("The owner's own role cannot be changed");
    const access: Record<string, MemoryRole> = { ...memory.access };
    if (role === null) {
      if (!has(access, uid)) return;
      delete access[uid];
    } else {
      if (access[uid] === role) return;
      access[uid] = role;
    }
    tx.update(memoryRef(memoryId), { ...withMembers(access), updatedAt: ctx.now });
  });
  return { ok: true as const, invited: false };
});
