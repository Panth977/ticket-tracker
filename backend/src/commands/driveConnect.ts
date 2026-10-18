/**
 * driveConnect (bucket.html §K1) — the Google consent page for MY Drive.
 * The person's own session only: a token can never connect someone's Drive.
 */
import { errors, isAgentId } from '@tm/shared';
import { driveConsentUrl } from '../bucket/drive/link.js';
import { defineCommand } from './_registry.js';

export default defineCommand('driveConnect', async (ctx, input) => {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('Connect Google Drive from the app (Account › Google Drive)');
  const returnTo = input.returnTo?.startsWith('//') ? '/' : (input.returnTo ?? '/account/drive');
  return { url: driveConsentUrl(ctx.actor, returnTo, ctx.now, ctx.email) };
});
