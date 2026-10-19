/**
 * driveRecoveryCode (bucket.html §L6) — the person's recovery code for their
 * Drive secrets, shown ONCE (then forgotten here); and whether they have one.
 */
import { errors, isAgentId } from '@tm/shared';
import { recoveryPublicKey, takeRecoveryCode, vaultStatus } from '../db/drive/keyring.js';
import { defineCommand } from './_registry.js';

export default defineCommand('driveRecoveryCode', async (ctx, input) => {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('Your recovery code is shown in the app only');
  if (input.take) {
    await recoveryPublicKey(ctx.actor); // made now if it was not yet
    return { ...(await vaultStatus(ctx.actor)), code: await takeRecoveryCode(ctx.actor) };
  }
  return { ...(await vaultStatus(ctx.actor)), code: null };
});
