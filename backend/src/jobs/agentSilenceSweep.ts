/**
 * Schedule `agentSilenceSweep` (every three minutes) — the phase-3 tick (§L).
 *
 * WHAT IS LEFT ON IT, AND WHY (§W). It used to run every minute, 4,261 times
 * in three days, mostly to notice that an agent had gone quiet — and noticing
 * that never needed a server: staleness is `now - at` where the beat is READ
 * (deriveAgentHealth), so a card goes red on its own. What is left here is
 * only the work that genuinely needs somebody awake, because nobody may be
 * looking at the board at all:
 *
 *   agents/silence.ts   a 'working' agent that has not beaten for 5 minutes →
 *                       one in-app row for its OWNER, once per silence (§L3).
 *                       Reads the RTDB status tree — one cheap fetch, no
 *                       Firestore collection-group query — and prunes the live
 *                       tree of streams nobody has touched in a week.
 *   tickets/questions.ts  a question whose expiresAt has passed → the card
 *                       locks as 'Expired' and the ticket stops waiting (§L1).
 *
 * Three minutes is the resolution both can tolerate: the silence threshold is
 * five minutes and an expiry is a deadline, not a stopwatch.
 */
import { ports } from '../adapters/index.js';
import { agentSilenceSweep } from '../agents/silence.js';
import { expireQuestions } from '../tickets/questions.js';
import { defineSchedule } from '../runtime/functions.js';

export default defineSchedule('agentSilenceSweep', async () => {
  const now = ports().clock.now();
  const silence = await agentSilenceSweep(now);
  const expired = await expireQuestions(now);
  console.info(
    `[agentSilenceSweep] checked=${silence.checked} notified=${silence.notices.length} pruned=${silence.pruned} expiredQuestions=${expired.length}`,
  );
});
