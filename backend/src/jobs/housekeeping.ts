/** Schedule `housekeeping` (daily 03:00 UTC) → notify/housekeeping.ts. */
import { ports } from '../adapters/index.js';
import { housekeeping } from '../notify/housekeeping.js';
import { defineSchedule } from '../runtime/functions.js';
import { pruneTasks } from '../runtime/localJobs.js';
import { platform } from '../runtime/platform.js';

export default defineSchedule('housekeeping', async () => {
  const now = ports().clock.now();
  const r = await housekeeping(now);
  // A VM's own task queue (runtime/localJobs.ts) keeps finished tasks for name dedupe.
  const tasksPruned = platform() === 'vm' ? await pruneTasks(now) : undefined;
  console.info(
    '[housekeeping]',
    JSON.stringify(tasksPruned === undefined ? r : { ...r, tasksPruned }),
  );
});
