/**
 * envSet — change a thing's env: `set` some pairs (null removes one), or
 * `replace` them all. At most ENV_PAIRS_MAX pairs after the change.
 */
import { ENV_PAIRS_MAX, envDocPath, errors, type EnvVars } from '@tm/shared';
import { db } from '../db/index.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { envOf, envTarget, type EnvDoc } from '../env/shared.js';

export default defineCommand('envSet', async (ctx, input) => {
  const { kind } = input.target;
  const t = await envTarget(ctx, kind, input.target.id, 'write');
  const ref = db().doc(envDocPath(kind, t.id));
  await runTx(async (tx) => {
    const cur = ((await tx.get(ref)).data() as EnvDoc | undefined)?.vars ?? {};
    let next: EnvVars;
    if (input.replace) next = { ...input.replace };
    else {
      next = { ...cur };
      for (const [k, v] of Object.entries(input.set ?? {})) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
    }
    if (Object.keys(next).length > ENV_PAIRS_MAX)
      throw errors.invalid(`At most ${ENV_PAIRS_MAX} pairs`);
    tx.set(ref, { vars: next, updatedAt: ctx.now, updatedBy: ctx.actor } satisfies EnvDoc);
  });
  return envOf(kind, t);
});
