/** Schedule `digestSend` (hourly, on the hour) → notify/digest.ts. */
import { ports } from '../adapters/index.js';
import { digestSend } from '../notify/digest.js';
import { defineSchedule } from '../runtime/functions.js';

export default defineSchedule('digestSend', async () => {
  const r = await digestSend(ports().clock.now());
  console.info(`[digestSend] sent=${r.sent.length} empty=${r.empty.length}`);
});
