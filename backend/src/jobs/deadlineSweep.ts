/** Schedule `deadlineSweep` (every 15 minutes) → notify/sweep.ts. */
import { ports } from '../adapters/index.js';
import { deadlineSweep } from '../notify/sweep.js';
import { defineSchedule } from '../runtime/functions.js';

export default defineSchedule('deadlineSweep', async () => {
  const r = await deadlineSweep(ports().clock.now());
  console.info(
    `[deadlineSweep] dueSoon=${r.dueSoon.length} overdue=${r.overdue.length} nudges=${r.nudges.length} boards=${Object.keys(r.boardCounts).length}`,
  );
});
