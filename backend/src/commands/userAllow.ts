/**
 * userAllow (§X) — the admin lets an ADDRESS in.
 *
 * By address, not by uid, because the point is to allow someone BEFORE they
 * have ever signed in: the list is written now, and onUserCreated picks the
 * flag up the moment they arrive. If they already have an account the mirror
 * (users/{uid}.allowed) is set straight away, so the security rules agree
 * without waiting for their next sign-in.
 *
 * Adding an address twice is not an error — it refreshes nothing and answers
 * with the same list (the screen is idempotent by nature: "make sure this
 * person is allowed").
 */
import { errors } from '@tm/shared';
import { isAdminEmail } from '@tm/shared/config';
import { allowEmail, assertAdmin, theAdmin, usersView } from '../platform/allow.js';
import { defineCommand } from './_registry.js';

export default defineCommand('userAllow', async (ctx, input) => {
  assertAdmin(ctx.email, ctx.emailVerified);
  const email = input.email;
  // The admin is allowed by definition; storing the row again would only
  // invite the idea that it could be taken away.
  if (isAdminEmail(email, theAdmin()))
    throw errors.conflict(`${theAdmin()} is the admin and is always allowed.`);
  // The view the module renders, built from the list we just wrote, so the
  // screen never has to guess what the server now thinks.
  return usersView(await allowEmail(email, ctx.actor, ctx.now, input.note));
});
