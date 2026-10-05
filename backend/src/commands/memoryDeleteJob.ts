/**
 * The `memoryDelete` queue handler (queued by memoryDelete and by account
 * deletion). The work is memory/purge.ts.
 */
import { purgeMemory } from '../memory/purge.js';
import { defineTask } from '../runtime/functions.js';

defineTask('memoryDelete', async ({ memoryId }) => {
  await purgeMemory(memoryId);
});
