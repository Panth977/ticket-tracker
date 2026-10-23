/** Schedule `stageRules` (hourly) → tickets/stageRules.ts. */
import { ports } from '../adapters/index.js';
import { defineSchedule } from '../runtime/functions.js';
import { runStageRules } from '../tickets/stageRules.js';

export default defineSchedule('stageRules', async () => {
  const r = await runStageRules(ports().clock.now());
  console.info('[stageRules]', JSON.stringify(r));
});
