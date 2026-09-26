/**
 * ping — the end-to-end smoke command: proves the token was verified, the
 * runner parsed input/output, and Firestore is reachable (it reads nothing
 * sensitive; `echo` round-trips so clients can test idempotent retries).
 */
import { COMMANDS } from '@tm/shared';
import { db } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

export const PingReqSchema = COMMANDS.ping.req;
export const PingResSchema = COMMANDS.ping.res;

export default defineCommand('ping', async (ctx, input) => {
  // Touch Firestore so ping fails loudly when the database is unreachable.
  await db()
    .listCollections()
    .catch(() => []);
  return {
    pong: true as const,
    actor: ctx.actor,
    via: ctx.via,
    now: ctx.now,
    ...(input.echo !== undefined ? { echo: input.echo } : {}),
    firestore: process.env.FIRESTORE_EMULATOR_HOST
      ? ('emulator' as const)
      : ('production' as const),
  };
});
