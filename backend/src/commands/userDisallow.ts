/**
 * userDisallow (§X) — the admin takes access away.
 *
 * WHAT HAPPENS, IN ORDER: the address leaves the list (the list is what every
 * door reads, so this alone ends their next request), the mirror on
 * users/{uid}.allowed goes to false for the security rules, and their refresh
 * tokens are revoked so the ID token in their browser stops verifying as well.
 * Their tokens and orchestrators stop with them — the API key path checks the
 * owner on every call.
 *
 * THE ADMIN CANNOT BE REMOVED. Not by anyone, including the admin: the address
 * comes from configuration, and an app whose owner locked themselves out would
 * need a console to get back in.
 */
import { errors } from '@tm/shared';
import { isAdminEmail } from '@tm/shared/config';
import {
  assertAdmin,
  disallowEmail,
  readAllowList,
  theAdmin,
  usersView,
} from '../platform/allow.js';
import { defineCommand } from './_registry.js';

export default defineCommand('userDisallow', async (ctx, input) => {
  assertAdmin(ctx.email, ctx.emailVerified);
  const email = input.email;
  if (isAdminEmail(email, theAdmin()))
    throw errors.conflict(`${theAdmin()} is the admin and cannot be removed.`);
  const before = await readAllowList();
  if (!before?.emails.some((e) => e.email === email))
    throw errors.not_found(`${email} is not on the list.`);
  return usersView(await disallowEmail(email, ctx.now));
});
