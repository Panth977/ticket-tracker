/**
 * Queue `deliver` → notify/deliver.ts (push, email, WhatsApp for one person
 * and one collapsed inbox row).
 */
import { deliver } from '../notify/deliver.js';
import { defineTask } from '../runtime/functions.js';

export default defineTask('deliver', async (data, meta) => {
  await deliver(data, meta);
});
