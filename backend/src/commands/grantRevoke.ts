/**
 * grantRevoke — Account › Connected apps. Owner only: delete the grant and
 * every oauthTokens row issued under it (access, refresh, pending codes). The
 * MCP client's next call gets 401 and must ask again.
 */
import { errors, paths } from '@tm/shared';
import { revokeGrantTokens } from '../platform/grants.js';
import { db } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

export default defineCommand('grantRevoke', async (ctx, input) => {
  const ref = db().doc(paths.oauthGrant(ctx.actor, input.grantId));
  if (!(await ref.get()).exists) throw errors.not_found('Connected app not found');
  await revokeGrantTokens(ctx.actor, input.grantId);
  await ref.delete();
  return { ok: true as const };
});
