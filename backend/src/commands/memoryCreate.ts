/**
 * memoryCreate (memory.html §A) — a person creates a memory and owns it.
 * Never an agent (D-M4: agents reach memory only through boards), never a
 * board token acting as a person. At most MEMORIES_OWNED_MAX owned.
 */
import {
  errors,
  isAgentId,
  MEMORIES_OWNED_MAX,
  MEMORY_DEFAULT_INDICATOR,
  type Memory,
} from '@tm/shared';
import { isBoardTokenAsPerson, memoriesCol, memoryRef, withMembers } from '../memory/shared.js';
import { defineCommand } from './_registry.js';
import { markOnCreate } from './indicatorShared.js';

export default defineCommand('memoryCreate', async (ctx, input) => {
  if (isAgentId(ctx.actor))
    throw errors.forbidden(
      'An agent cannot create a memory — it uses the memories granted to its boards',
    );
  if (isBoardTokenAsPerson(ctx))
    throw errors.forbidden(
      'A board token cannot create memory — use an account token (Account › Tokens)',
    );
  const owned = await memoriesCol().where('ownerUid', '==', ctx.actor).count().get();
  if (owned.data().count >= MEMORIES_OWNED_MAX)
    throw errors.conflict(`You can own at most ${MEMORIES_OWNED_MAX} memories`);

  const memoryId = ctx.ids.id();
  const memory: Memory = {
    name: input.name,
    description: input.description || null,
    ...markOnCreate(input, MEMORY_DEFAULT_INDICATOR),
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
  await memoryRef(memoryId).create(memory);
  return { memoryId };
});
