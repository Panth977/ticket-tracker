/**
 * apiKeyRevoke — owner only; revokedAt = now, revokedReason 'owner'. The very
 * next call with the key gets 401 (the middleware reads revokedAt on every
 * request). Revoking twice is ok.
 */
import { ctxOwner, errors, isAgentId, paths } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, mustGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

export default defineCommand('apiKeyRevoke', async (ctx, input) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot revoke tokens');
  const ref = typedDoc('apiKeys', paths.apiKey(ctxOwner(ctx), input.keyId));
  await runTx(async (tx) => {
    const key = await mustGet(tx, ref, 'API key not found');
    if (key.revokedAt !== null) return; // already revoked: idempotent
    tx.update(ref, { revokedAt: ctx.now, revokedReason: 'owner' });
  });
  return { ok: true as const };
});
