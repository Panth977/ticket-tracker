/** handleSet (§AC) — a person's own handle (their /{handle}/… URLs). */
import { errors, isAgentId, paths } from '@tm/shared';
import { db } from '../db/index.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { claimHandle, handleRef } from '../org/shared.js';

export default defineCommand('handleSet', async (ctx, input) => {
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents have no handle');
  const ref = db().doc(paths.user(ctx.actor));
  await runTx(async (tx) => {
    const cur = ((await tx.get(ref)).data() as { handle?: string } | undefined)?.handle;
    if (cur === input.handle) return;
    await claimHandle(tx, input.handle, { kind: 'user', id: ctx.actor });
    if (cur) tx.delete(handleRef(cur));
    tx.update(ref, { handle: input.handle });
  });
  return { ok: true as const };
});
