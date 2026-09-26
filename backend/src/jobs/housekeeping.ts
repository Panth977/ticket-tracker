/** Schedule `housekeeping` (daily 03:00 UTC) → notify/housekeeping.ts. */
import { ports } from '../adapters/index.js';
import { housekeeping } from '../notify/housekeeping.js';
import { defineSchedule } from '../runtime/functions.js';

export default defineSchedule('housekeeping', async () => {
  const r = await housekeeping(ports().clock.now());
  console.info('[housekeeping]', JSON.stringify(r));
});
