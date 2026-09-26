/**
 * profileUpdate — any signed-in user, their own users/{actor}.
 *
 *   avatarPath  must be under users/{actor}/avatar/, exist, and be an image
 *               (≤ 5 MB); the previous picture is deleted. null removes it.
 *   name / avatar changed → every members/ row of theirs is updated
 *               (collectionGroup('members') where uid == actor).
 *   notify      Account › Notifications: channels merged per event; the
 *               other keys replace.
 *   whatsappOptIn  only for an already-verified number.
 *
 * EMAIL IS NOT HERE: it is the sign-in identity, changed through Firebase
 * Auth's verify-new-email flow; the beforeUserSignedIn trigger copies it.
 */
import { errors, MAX_AVATAR_BYTES, storage, type User } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { ensureUserDoc, fanOutToMembers, isTimeZone, userRef } from './profileShared.js';

export default defineCommand('profileUpdate', async (ctx, input) => {
  if (input.timezone !== undefined && !isTimeZone(input.timezone))
    throw errors.invalid('Unknown time zone', { field: 'timezone' });

  if (input.avatarPath) {
    const prefix = storage.avatarPrefix(ctx.actor);
    if (!input.avatarPath.startsWith(prefix) || input.avatarPath.slice(prefix.length).includes('/'))
      throw errors.invalid(`avatarPath must be under ${prefix}`, { field: 'avatarPath' });
    const obj = await ports().files.stat(input.avatarPath);
    if (!obj) throw errors.not_found('Upload the picture first', { field: 'avatarPath' });
    if (!obj.contentType.startsWith('image/'))
      throw errors.invalid('The picture must be an image', { field: 'avatarPath' });
    if (obj.size > MAX_AVATAR_BYTES)
      throw errors.invalid('The picture is larger than 5 MB', { field: 'avatarPath' });
  }

  await ensureUserDoc(ctx.actor, ctx.now);

  const { before } = await runTx(async (tx) => {
    const user = (await txGet(tx, userRef(ctx.actor)))!;
    if (user.deletedAt !== null) throw errors.not_found('Account deleted');
    const u: Record<string, unknown> = {};
    if (input.name !== undefined) u.name = input.name;
    if (input.avatarPath !== undefined) u.avatarPath = input.avatarPath;
    if (input.timezone !== undefined) u.timezone = input.timezone;
    if (input.locale !== undefined) u.locale = input.locale;
    if (input.theme !== undefined) u.theme = input.theme;
    if (input.notify) {
      const { channels, ...rest } = input.notify;
      for (const [event, list] of Object.entries(channels ?? {}))
        if (list) u[`notify.channels.${event}`] = [...new Set(list)];
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) u[`notify.${k}`] = v;
    }
    if (input.whatsappOptIn !== undefined) {
      if (!user.whatsapp)
        throw errors.invalid('Link and verify a WhatsApp number first', { field: 'whatsappOptIn' });
      u['whatsapp.optIn'] = input.whatsappOptIn;
    }
    if (Object.keys(u).length) tx.update(userRef(ctx.actor), u);
    return { before: user as User };
  });

  const fan: Partial<{ name: string; avatarPath: string | null }> = {};
  if (input.name !== undefined && input.name !== before.name) fan.name = input.name;
  if (input.avatarPath !== undefined && input.avatarPath !== before.avatarPath)
    fan.avatarPath = input.avatarPath;
  await fanOutToMembers(ctx.actor, fan);

  // The previous picture is deleted (only ever our own avatar objects).
  if (
    fan.avatarPath !== undefined &&
    before.avatarPath &&
    before.avatarPath.startsWith(storage.avatarPrefix(ctx.actor))
  )
    await ports()
      .files.delete(before.avatarPath)
      .catch((e) => console.warn('[profileUpdate] old avatar delete failed', e));

  return { ok: true as const };
});
