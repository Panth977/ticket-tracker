/**
 * drivePickerToken (bucket.html §K1) — a short-lived access token for Google's
 * folder picker, for the person whose Drive it is, in their own app session.
 */
import { errors, isAgentId } from '@tm/shared';
import { pickerToken } from '../bucket/drive/link.js';
import { defineCommand } from './_registry.js';

export default defineCommand('drivePickerToken', async (ctx) => {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('The Drive folder picker runs in the app only');
  return pickerToken(ctx.actor);
});
