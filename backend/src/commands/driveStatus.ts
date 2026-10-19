/** driveStatus (bucket.html §K1) — is my Google Drive connected? */
import { errors, isAgentId } from '@tm/shared';
import { driveStatusOf } from '../bucket/drive/link.js';
import { defineCommand } from './_registry.js';

export default defineCommand('driveStatus', async (ctx) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('An agent has no Google Drive');
  return driveStatusOf(ctx.actor);
});
