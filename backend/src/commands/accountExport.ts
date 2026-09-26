/**
 * accountExport — themselves. Queued: the `export` job (accountExportJob.ts)
 * zips profile, messages authored and tickets created / assigned (JSON, plus
 * the files attached to their messages) into Storage and e-mails a signed
 * URL valid 7 days. 3 exports per person per day.
 */
import { rateBuckets } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { defineCommand } from './_registry.js';
import { takeRate } from './boardShared.js';

export const EXPORTS_PER_DAY = 3;
const exportBucket = (uid: string) => rateBuckets.exports(uid);

export default defineCommand('accountExport', async (ctx) => {
  await takeRate(exportBucket(ctx.actor), EXPORTS_PER_DAY, ctx.now);
  const jobId = ctx.ids.id();
  await ports().queue.enqueue('export', { jobId, uid: ctx.actor }, { name: `export-${jobId}` });
  return { jobId };
});
