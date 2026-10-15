/**
 * bucketCreate (bucket.html §A) — a person creates a bucket and owns it.
 * Never an agent (D-M4: agents reach bucket only through boards), never a
 * board token acting as a person. At most BUCKETS_OWNED_MAX owned.
 */
import {
  errors,
  isAgentId,
  BUCKETS_OWNED_MAX,
  BUCKET_DEFAULT_INDICATOR,
  type Bucket,
} from '@tm/shared';
import { isBoardTokenAsPerson, bucketsCol, bucketRef, withMembers } from '../bucket/shared.js';
import { defineCommand } from './_registry.js';
import { markOnCreate } from './indicatorShared.js';

export default defineCommand('bucketCreate', async (ctx, input) => {
  if (isAgentId(ctx.actor))
    throw errors.forbidden(
      'An agent cannot create a bucket — it uses the buckets granted to its boards',
    );
  if (isBoardTokenAsPerson(ctx))
    throw errors.forbidden(
      'A board token cannot create bucket — use an account token (Account › Tokens)',
    );
  const owned = await bucketsCol().where('ownerUid', '==', ctx.actor).count().get();
  if (owned.data().count >= BUCKETS_OWNED_MAX)
    throw errors.conflict(`You can own at most ${BUCKETS_OWNED_MAX} buckets`);

  const bucketId = ctx.ids.id();
  const bucket: Bucket = {
    name: input.name,
    description: input.description || null,
    ...markOnCreate(input, BUCKET_DEFAULT_INDICATOR),
    ownerUid: ctx.actor,
    ...withMembers({ [ctx.actor]: 'owner' }),
    boards: {},
    artifacts: {},
    boardIds: [],
    stats: { files: 0, folders: 0, bytes: 0 },
    archivedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await bucketRef(bucketId).create(bucket);
  return { bucketId };
});
