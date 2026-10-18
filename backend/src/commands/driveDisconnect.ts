/**
 * driveDisconnect (bucket.html §K1) — forget my Drive connection and revoke it
 * at Google. My Drive buckets stay (their files are in Drive) but cannot be
 * opened until I connect again.
 */
import { errors, isAgentId } from '@tm/shared';
import { disconnectDrive } from '../bucket/drive/link.js';
import { defineCommand } from './_registry.js';

export default defineCommand('driveDisconnect', async (ctx) => {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('Disconnect Google Drive from the app (Account › Connections)');
  await disconnectDrive(ctx.actor);
  return { ok: true as const };
});
