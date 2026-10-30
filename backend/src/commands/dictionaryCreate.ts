/**
 * dictionaryCreate (dictionary.html §C) — a person creates a dictionary and
 * owns it (or the org they name). Never an agent, never a board token acting
 * as a person. At most DICTIONARIES_OWNED_MAX owned.
 */
import {
  DICTIONARIES_OWNED_MAX,
  DICTIONARY_DEFAULT_INDICATOR,
  entriesIn,
  errors,
  isAgentId,
  type Dictionary,
} from '@tm/shared';
import { isBoardTokenAsPerson } from '../bucket/shared.js';
import { contentRef, dictionariesCol, dictionaryRef, withMembers } from '../dictionary/shared.js';
import { freeSlug, ownerForCreate, syncThing } from '../org/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('dictionaryCreate', async (ctx, input) => {
  if (isAgentId(ctx.actor))
    throw errors.forbidden(
      'An agent cannot create a dictionary — it uses the ones granted to it and its boards',
    );
  if (isBoardTokenAsPerson(ctx))
    throw errors.forbidden(
      'A board token cannot create a dictionary — use an account token (Account › Tokens)',
    );
  const owned = await dictionariesCol().where('ownerUid', '==', ctx.actor).count().get();
  if (owned.data().count >= DICTIONARIES_OWNED_MAX)
    throw errors.conflict(`You can own at most ${DICTIONARIES_OWNED_MAX} dictionaries`);
  let stored: ReturnType<typeof entriesIn>;
  try {
    stored = entriesIn(input.entries ?? []);
  } catch (e) {
    throw errors.invalid((e as Error).message);
  }

  const own = await ownerForCreate(ctx.actor, input.owner);
  const slug = await freeSlug('dictionary', own.fields.owner, input.name);
  const dictionaryId = ctx.ids.id();
  const d: Dictionary = {
    name: input.name,
    description: input.description || null,
    indicator: input.indicator ?? DICTIONARY_DEFAULT_INDICATOR,
    ownerUid: ctx.actor,
    ...own.fields,
    slug,
    ...withMembers({ [ctx.actor]: 'owner' }),
    boards: {},
    artifacts: {},
    agents: {},
    boardIds: [],
    artifactIds: [],
    agentIds: [],
    stats: { entries: stored.entries.length, bytes: stored.bytes },
    archivedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await dictionaryRef(dictionaryId).create(d);
  await contentRef(dictionaryId).set({
    entries: stored.entries,
    updatedAt: ctx.now,
    updatedBy: ctx.actor,
  });
  if (own.org) await syncThing('dictionary', dictionaryId, own.org);
  return { dictionaryId };
});
