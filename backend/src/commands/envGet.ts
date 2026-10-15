/** envGet — a thing's own, inherited and effective env (shared/src/env). */
import { defineCommand } from './_registry.js';
import { envOf, envTarget } from '../env/shared.js';

export default defineCommand('envGet', async (ctx, input) => {
  const t = await envTarget(ctx, input.target.kind, input.target.id, 'read');
  return envOf(input.target.kind, t);
});
