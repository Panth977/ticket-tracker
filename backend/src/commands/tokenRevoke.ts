/**
 * tokenRevoke (ORCH-73) — the token-reachable revoke. Only one of the
 * caller's tokens that ACTS AS ONE OF THEIR AGENTS (board or agent token);
 * account tokens and tokens acting as the person stay app-only
 * (apiKeyRevoke, on TOKEN_DENIED_COMMANDS), so a leaked token cannot lock
 * its owner out of their other tokens. Revoking twice is ok.
 */
import { ctxOwner, errors, isAgentId, paths } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { mustGet, runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('tokenRevoke', async (ctx, input) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot revoke tokens');
  const ref = typedDoc('apiKeys', paths.apiKey(ctxOwner(ctx), input.keyId));
  await runTx(async (tx) => {
    const key = await mustGet(tx, ref, 'Token not found');
    if (key.actsAs.kind !== 'agent' || key.kind === 'account')
      throw errors.forbidden(
        'Only tokens acting as one of your agents can be revoked here — revoke this one in Account › Tokens',
      );
    if (key.revokedAt !== null) return;
    tx.update(ref, { revokedAt: ctx.now, revokedReason: 'owner' });
  });
  return { ok: true as const };
});
