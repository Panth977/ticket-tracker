/**
 * userList (§X) — the Users module's read: who may use this app, when they
 * were added, and when they last signed in. The ADMIN ONLY; there is nothing
 * here for anyone else to see, and no token of any kind can call it.
 */
import { assertAdmin, readAllowList, usersView } from '../platform/allow.js';
import { defineCommand } from './_registry.js';

export default defineCommand('userList', async (ctx) => {
  assertAdmin(ctx.email, ctx.emailVerified);
  return usersView(await readAllowList());
});
